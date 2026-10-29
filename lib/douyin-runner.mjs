import { chromium } from "playwright";
import {
  containsAnyKeyword,
  normalizeDisplayName,
  randomInteger,
  sampleWithoutReplacement
} from "./core.mjs";
import {
  applySearch,
  artifactLabel,
  collectSearchCandidates,
  detectPageGate,
  discoverBrowserExecutable,
  extractTopLevelComments,
  openCandidate,
  readCurrentUser,
  scrollComments,
  sendDirectMessage,
  waitForComments
} from "./douyin-page.mjs";

export class StoppedError extends Error {
  constructor() {
    super("任务已停止");
    this.name = "StoppedError";
  }
}

export class FatalRunError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalRunError";
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleGate(run, page, initialGate) {
  let gate = initialGate;
  while (gate) {
    if (gate.type === "restricted") throw new FatalRunError(gate.detail);
    run.setStatus("waiting_login", gate.detail);
    run.log("warn", `${gate.detail}。请在打开的浏览器中完成操作，然后点击“继续”。`);
    await run.waitForContinue();
    run.throwIfStopped();
    await page.waitForTimeout(800);
    gate = await detectPageGate(page);
  }
}

async function scanVideoComments({
  run,
  page,
  candidate,
  videoId,
  config,
  currentUser,
  contactedUsers,
  seenUserIds
}) {
  await waitForComments(page, config.actionTimeoutMs);
  const matches = [];
  const seenComments = new Set();
  let scanned = 0;

  for (let scrollRound = 0; scrollRound <= config.maxScrolls; scrollRound += 1) {
    run.throwIfStopped();
    const gate = await detectPageGate(page);
    if (gate) await handleGate(run, page, gate);

    const comments = await extractTopLevelComments(page, config.maxComments);
    for (const comment of comments) {
      const commentKey = `${comment.userId}\u0000${comment.commentText}`;
      if (seenComments.has(commentKey)) continue;
      seenComments.add(commentKey);
      scanned += 1;
      if (scanned > config.maxComments) break;

      const sameAsAuthor =
        comment.isAuthor ||
        normalizeDisplayName(comment.username) ===
          normalizeDisplayName(candidate.author);
      const sameAsSelf =
        (currentUser.userId && comment.userId === currentUser.userId) ||
        (currentUser.username &&
          normalizeDisplayName(comment.username) ===
            normalizeDisplayName(currentUser.username));
      const alreadyContacted = contactedUsers.has(comment.userId);
      const alreadySeen = seenUserIds.has(comment.userId);

      if (
        !comment.userId ||
        sameAsAuthor ||
        sameAsSelf ||
        alreadyContacted ||
        alreadySeen ||
        !containsAnyKeyword(comment.commentText, config.keywordList)
      ) {
        continue;
      }

      const matchedKeyword = config.keywordList.find((keyword) =>
        comment.commentText.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())
      );
      matches.push({
        ...comment,
        matchedKeyword,
        videoId,
        videoTitle: candidate.title,
        videoAuthor: candidate.author
      });
      seenUserIds.add(comment.userId);
      if (matches.length >= config.matchesPerVideo) break;
    }

    run.updateCounts({ scannedComments: run.counts.scannedComments + scanned });
    scanned = 0;
    if (
      matches.length >= config.matchesPerVideo ||
      seenComments.size >= config.maxComments
    ) {
      break;
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/暂时没有更多评论|没有更多评论/.test(bodyText)) break;
    await scrollComments(page);
    await page.waitForTimeout(650);
  }
  return matches;
}

async function sendMatch({ run, page, match, config, storage, contactedUsers }) {
  run.throwIfStopped();
  run.setStatus("sending", `正在向 ${match.username} 发送私信`);
  const sendOptions = {
    expectedUsername: match.username,
    onStage: (message) => run.log("info", message)
  };
  const attemptSend = async () => {
    try {
      return await sendDirectMessage(
        page,
        match.userHref,
        config.message,
        config,
        sendOptions
      );
    } catch (error) {
      return {
        status: "failed",
        detail: `私信操作异常：${error.message}`
      };
    }
  };
  let outcome = await attemptSend();

  if (outcome.status === "waiting_login") {
    await handleGate(run, page, outcome.gate);
    outcome = await attemptSend();
  }
  if (outcome.gate?.type === "restricted") {
    throw new FatalRunError(outcome.gate.detail);
  }

  const result = {
    ...match,
    status: outcome.status,
    detail: outcome.detail ?? "",
    timestamp: new Date().toISOString()
  };
  run.addResult(result);

  if (outcome.status === "sent") {
    const contactedRecord = {
      userId: match.userId,
      username: match.username,
      userHref: match.userHref,
      firstContactedAt: result.timestamp,
      videoId: match.videoId,
      videoTitle: match.videoTitle,
      commentText: match.commentText
    };
    await storage.appendContactedUser(contactedRecord);
    contactedUsers.set(match.userId, contactedRecord);
    run.updateCounts({ sent: run.counts.sent + 1 });
    run.log(
      "info",
      `已向 ${match.username} 发送私信并完成页面核验（${outcome.detail}）`
    );
  } else if (outcome.status === "blocked") {
    await storage.saveScreenshot(run.id, page, `${match.userId}-blocked`);
    run.updateCounts({ blocked: run.counts.blocked + 1 });
    run.log("warn", `${match.username}：${outcome.detail || "私信被限制"}`);
  } else {
    await storage.saveScreenshot(run.id, page, `${match.userId}-dm-unavailable`);
    run.updateCounts({ failed: run.counts.failed + 1 });
    run.log("warn", `${match.username}：${outcome.detail || "无法发送私信"}`);
  }
}

export async function processMatchedUsers({
  mode,
  matches,
  run,
  send = sendMatch,
  sendContext = {}
}) {
  if (mode === "preview") {
    for (const match of matches) {
      run.addResult({
        ...match,
        status: "preview",
        detail: "仅预览，未打开私信窗口",
        timestamp: new Date().toISOString()
      });
    }
    return;
  }

  for (let index = 0; index < matches.length; index += 1) {
    await send({ run, match: matches[index], ...sendContext });
    run.throwIfStopped();
    if (index < matches.length - 1) {
      const delay = randomInteger(
        sendContext.config.minDelayMs,
        sendContext.config.maxDelayMs
      );
      run.log("info", `等待 ${(delay / 1000).toFixed(1)} 秒后继续`);
      await sleep(delay);
    }
  }
}

export async function runDouyinTask(run, storage) {
  const { config, mode } = run;
  const executablePath = discoverBrowserExecutable();
  const contactedUsers = await storage.loadContactedUsers();
  const seenUserIds = new Set();
  let context;

  try {
    run.log("info", `启动浏览器：${executablePath}`);
    run.log(
      "info",
      "登录 Cookie 和本地存储由 Chrome 保存在 data/browser-profile，不导出明文 Cookie"
    );
    context = await chromium.launchPersistentContext(storage.profileDir, {
      headless: false,
      executablePath,
      viewport: null,
      args: ["--start-maximized"]
    });
    const searchPage = context.pages()[0] || (await context.newPage());
    const videoPage = await context.newPage();
    const messagePage = await context.newPage();
    for (const page of [searchPage, videoPage, messagePage]) {
      page.setDefaultTimeout(config.actionTimeoutMs);
      page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    }
    run.log("info", "已创建独立的搜索页、视频详情页和私信页");

    await searchPage.goto("https://www.douyin.com/", {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs
    });
    await searchPage.waitForTimeout(1_000);
    const initialGate = await detectPageGate(searchPage);
    if (initialGate) await handleGate(run, searchPage, initialGate);

    let currentUser = await readCurrentUser(
      searchPage,
      config.navigationTimeoutMs
    );
    if (currentUser.gate) {
      await handleGate(run, searchPage, currentUser.gate);
      currentUser = await readCurrentUser(
        searchPage,
        config.navigationTimeoutMs
      );
    }
    if (!currentUser.userId) {
      throw new FatalRunError("无法确认当前登录账号，已停止以避免向自身发送私信");
    }
    run.log("info", `当前账号：${currentUser.username || currentUser.userId}`);

    run.throwIfStopped();
    run.setStatus("searching", `正在搜索“${config.query}”`);
    let search = await applySearch(searchPage, config);
    if (search.gate) {
      await handleGate(run, searchPage, search.gate);
      search = await applySearch(searchPage, config);
    }

    const candidates = await collectSearchCandidates(
      searchPage,
      config,
      (count) => {
        run.updateCounts({ candidateVideos: count });
      }
    );
    if (candidates.length < config.videoCount) {
      run.log(
        "warn",
        `筛选后仅找到 ${candidates.length} 个视频，少于目标 ${config.videoCount} 个，将继续处理已找到的视频`
      );
    }
    const selected = sampleWithoutReplacement(candidates, config.videoCount);
    run.updateCounts({ selectedVideos: selected.length });
    run.log(
      "info",
      `已随机选中 ${selected.length} 个视频：${selected.map((item) => item.title).join("；")}`
    );

    for (const candidate of selected) {
      run.throwIfStopped();
      run.setStatus("scanning", `正在扫描视频：${candidate.title}`);
      let videoId = candidate.videoId;

      try {
        const opened = await openCandidate(
          searchPage,
          candidate,
          search.searchUrl,
          config,
          videoPage
        );
        if (opened?.gate) {
          await handleGate(run, searchPage, opened.gate);
          videoId = await openCandidate(
            searchPage,
            candidate,
            search.searchUrl,
            config,
            videoPage
          );
        } else {
          videoId = opened;
        }

        await videoPage.waitForTimeout(700);
        const gate = await detectPageGate(videoPage);
        if (gate) await handleGate(run, videoPage, gate);

        const matches = await scanVideoComments({
          run,
          page: videoPage,
          candidate,
          videoId,
          config,
          currentUser,
          contactedUsers,
          seenUserIds
        });
        run.updateCounts({ matchedUsers: run.counts.matchedUsers + matches.length });

        if (!matches.length) {
          run.addResult({
            videoId,
            videoTitle: candidate.title,
            videoAuthor: candidate.author,
            username: "",
            userId: "",
            commentText: "",
            matchedKeyword: "",
            status: "no_match",
            detail: "在扫描上限内没有找到符合条件的新用户",
            timestamp: new Date().toISOString()
          });
          run.log("info", `视频“${candidate.title}”没有找到符合条件的新用户`);
          continue;
        }

        await processMatchedUsers({
          mode,
          matches,
          run,
          sendContext: {
            page: messagePage,
            config,
            storage,
            contactedUsers
          }
        });
        if (mode === "send" && candidate !== selected.at(-1)) {
          const delay = randomInteger(config.minDelayMs, config.maxDelayMs);
          run.log("info", `等待 ${(delay / 1000).toFixed(1)} 秒后继续下一个视频`);
          await sleep(delay);
        }
      } catch (error) {
        if (error instanceof StoppedError || error instanceof FatalRunError) throw error;
        await storage.saveScreenshot(
          run.id,
          videoPage,
          artifactLabel(candidate, "error")
        );
        run.addResult({
          videoId,
          videoTitle: candidate.title,
          videoAuthor: candidate.author,
          username: "",
          userId: "",
          commentText: "",
          matchedKeyword: "",
          status: "failed",
          detail: error.message,
          timestamp: new Date().toISOString()
        });
        run.updateCounts({ failed: run.counts.failed + 1 });
        run.log("error", `视频“${candidate.title}”处理失败：${error.message}`);
      }
    }
  } finally {
    await context?.close().catch(() => {});
  }
}
