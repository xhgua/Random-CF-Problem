/* ===========================================
   Random Codeforces Problem — Application Logic
   =========================================== */

// =============================================
// 1. CONSTANTS & DOM REFS
// =============================================

const CF_API_URL = "https://codeforces.com/api/problemset.problems";
const CONTEST_LIST_URL = "https://codeforces.com/api/contest.list";
const USER_STATUS_URL = "https://codeforces.com/api/user.status?handle=";
const CACHE_KEY = "cf_problems_cache";
const CONTEST_NAMES_KEY = "cf_contest_names";
const HISTORY_KEY = "cf_history";
const SOLVED_CACHE_KEY = "cf_solved_cache";
const SUBMISSIONS_CACHE_KEY = "cf_submissions_cache";
const CACHE_TTL = 24 * 60 * 60 * 1000;    // 24 hours (problems)
const CONTEST_NAMES_TTL = 24 * 60 * 60 * 1000; // 24 hours (contest names)
const SOLVED_CACHE_TTL = 60 * 60 * 1000;   // 1 hour (solved set)
const MAX_HISTORY = 50;
const FETCH_TIMEOUT = 15000;

// Known Kotlin Heroes contest IDs
const KOTLIN_CONTESTS = new Set([
  1170, 1211, 1297, 1346, 1430, 1479, 1525,
  1571, 1659, 1761, 1840, 1913
]);

// DOM refs
const $ = function (sel) { return document.querySelector(sel); };
const $$ = function (sel) { return document.querySelectorAll(sel); };

const dom = {
  loadingOverlay: $("#loadingOverlay"),
  filtersSection: $("#filtersSection"),
  cacheStatus: $("#cacheStatus"),
  errorBanner: $("#errorBanner"),

  // Tabs
  tabBtns: $$(".tab-btn"),
  pickerPage: $("#pickerPage"),
  statsPage: $("#statsPage"),
  statsContent: $("#statsContent"),
  contestsPage: $("#contestsPage"),
  contestsContent: $("#contestsContent"),
  contestsSearch: $("#contestsSearch"),

  // Handle
  cfHandle: $("#cfHandle"),
  handleStatus: $("#handleStatus"),
  excludeSolved: $("#excludeSolved"),
  excludeSolvedLabel: $("#excludeSolvedLabel"),
  excludeHandleName: $("#excludeHandleName"),
  showTags: $("#showTags"),
  minContestId: $("#minContestId"),

  // Rating
  ratingMin: $("#ratingMin"),
  ratingMax: $("#ratingMax"),

  // Tags
  tagSearch: $("#tagSearch"),
  tagContainer: $("#tagContainer"),
  clearTagsBtn: $("#clearTagsBtn"),

  // Problem
  problemCount: $("#problemCount"),
  rollBtn: $("#rollBtn"),
  problemCardSection: $("#problemCardSection"),
  problemCard: $("#problemCard"),

  // History
  historyList: $("#historyList"),
  clearHistoryBtn: $("#clearHistoryBtn"),

  // Misc
  refreshCacheBtn: $("#refreshCacheBtn"),
};

// =============================================
// 2. STATE
// =============================================

let allProblems = [];              // { contestId, index, name, rating, tags, solvedCount }
let contestNames = new Map();      // contestId → contest name
let selectedTags = new Set();
let ratingMin = 0;
let ratingMax = 3500;
let currentProblem = null;
let history = [];
let cacheTimestamp = null;

// Kotlin
let excludeKotlin = true;

// Min contest ID
let minContestId = 0;

// Handle & solved
let cfHandle = "";
let excludeSolved = false;
let solvedProblemIds = new Set();  // Set of "contestId:index" strings
let userSubmissions = [];         // raw submissions for stats page
let submissionsLoading = false;

// Tab
let currentTab = "picker";

// Contests pagination
const CONTESTS_PAGE_SIZE = 15;
let contestsPage = 1;

// Tag abbreviation map
var TAG_ABBR = {
  "chinese remainder theorem": "CRT",
};

function shortenTag(tag) {
  return TAG_ABBR[tag] || tag;
}

// =============================================
// 3. STORAGE HELPERS
// =============================================

function loadCache() {
  try {
    var raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !Array.isArray(data.problems)) return null;
    return data;
  } catch (e) {
    console.warn("Failed to load cache:", e);
    return null;
  }
}

function saveCache(problems, timestamp) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ problems: problems, timestamp: timestamp }));
  } catch (e) {
    console.warn("Failed to save cache:", e);
  }
}

function loadHistory() {
  try {
    var raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    var data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) { return []; }
}

function saveHistory(arr) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
  } catch (e) { /* ignore */ }
}

function loadSolvedCache(handle) {
  try {
    var raw = localStorage.getItem(SOLVED_CACHE_KEY);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || data.handle !== handle) return null;
    if (Date.now() - data.timestamp > SOLVED_CACHE_TTL) return null;
    return data; // { handle, timestamp, solvedIds: [...] }
  } catch (e) { return null; }
}

function saveSolvedCache(handle, solvedIds, submissions) {
  try {
    var data = {
      handle: handle,
      timestamp: Date.now(),
      solvedIds: Array.from(solvedIds)
    };
    localStorage.setItem(SOLVED_CACHE_KEY, JSON.stringify(data));
    // Save submissions separately (can be large)
    localStorage.setItem(SUBMISSIONS_CACHE_KEY, JSON.stringify({
      handle: handle,
      timestamp: Date.now(),
      submissions: submissions
    }));
  } catch (e) {
    console.warn("Failed to save solved cache:", e);
  }
}

function loadSubmissionsCache(handle) {
  try {
    var raw = localStorage.getItem(SUBMISSIONS_CACHE_KEY);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || data.handle !== handle) return null;
    if (Date.now() - data.timestamp > SOLVED_CACHE_TTL) return null;
    return data.submissions;
  } catch (e) { return null; }
}

function loadContestNames() {
  try {
    var raw = localStorage.getItem(CONTEST_NAMES_KEY);
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries)) return null;
    if (Date.now() - data.timestamp > CONTEST_NAMES_TTL) return null;
    return new Map(data.entries);
  } catch (e) { return null; }
}

function saveContestNames(map) {
  try {
    localStorage.setItem(CONTEST_NAMES_KEY, JSON.stringify({
      timestamp: Date.now(),
      entries: Array.from(map.entries())
    }));
  } catch (e) { /* ignore */ }
}

// =============================================
// 4. API
// =============================================

async function fetchProblems() {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT);

  try {
    var response = await fetch(CF_API_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error("HTTP " + response.status + ": " + response.statusText);
    }

    var json = await response.json();

    if (json.status !== "OK") {
      throw new Error("Codeforces API returned error: " + (json.comment || "Unknown error"));
    }

    var problems = json.result.problems;
    var stats = json.result.problemStatistics;

    var statsMap = new Map();
    if (stats) {
      stats.forEach(function (s) {
        statsMap.set(s.contestId + ":" + s.index, s.solvedCount);
      });
    }

    var cleaned = problems.map(function (p) {
      return {
        contestId: p.contestId,
        index: p.index,
        name: p.name,
        rating: p.rating || 0,
        tags: p.tags,
        solvedCount: statsMap.get(p.contestId + ":" + p.index) || 0,
      };
    });

    return cleaned;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("Request timed out after " + FETCH_TIMEOUT / 1000 + "s");
    }
    throw e;
  }
}

async function fetchUserSubmissions(handle) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, 30000); // 30s for user data

  var response = await fetch(USER_STATUS_URL + encodeURIComponent(handle), {
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  var json = await response.json();

  if (json.status !== "OK") {
    throw new Error(json.comment || "Unknown error");
  }

  var submissions = json.result;
  var solvedIds = new Set();

  submissions.forEach(function (sub) {
    if (sub.verdict === "OK" && sub.problem) {
      var key = sub.problem.contestId + ":" + sub.problem.index;
      solvedIds.add(key);
    }
  });

  return { solvedIds: solvedIds, submissions: submissions };
}

async function fetchContestNames() {
  var response = await fetch(CONTEST_LIST_URL);
  if (!response.ok) throw new Error("HTTP " + response.status);
  var json = await response.json();
  if (json.status !== "OK") throw new Error(json.comment || "Unknown error");
  var map = new Map();
  json.result.forEach(function (c) {
    map.set(c.id, c.name);
  });
  return map;
}

// =============================================
// 5. INITIALIZATION
// =============================================

async function initProblems() {
  showLoading(true);
  hideError();
  hideCacheStatus();

  var cache = loadCache();
  var now = Date.now();

  if (cache && cache.problems.length > 0 && (now - cache.timestamp) < CACHE_TTL) {
    allProblems = cache.problems;
    cacheTimestamp = cache.timestamp;
    showLoading(false);
    showCacheStatus(
      "Using cached data (" + formatTimeAgo(now - cache.timestamp) + " old). " +
      "Click Refresh to fetch latest."
    );
    setTimeout(hideCacheStatus, 6000);
    onDataReady();
    loadContestNamesAsync();
    return;
  }

  try {
    var problems = await fetchProblems();
    allProblems = problems;
    cacheTimestamp = Date.now();
    saveCache(problems, cacheTimestamp);
    showLoading(false);
    showCacheStatus("Data fetched successfully · " + problems.length + " problems loaded.");
    setTimeout(hideCacheStatus, 4000);
    onDataReady();
    loadContestNamesAsync();
  } catch (e) {
    console.error("Failed to fetch problems:", e);
    if (cache && cache.problems.length > 0) {
      allProblems = cache.problems;
      cacheTimestamp = cache.timestamp;
      showLoading(false);
      showError(
        "Failed to fetch latest data: " + e.message + ". " +
        "Using cached data from " + formatTimeAgo(now - cache.timestamp) + " ago."
      );
      onDataReady();
      loadContestNamesAsync();
    } else {
      showLoading(false);
      showError("Failed to load problems: " + e.message, true);
      dom.rollBtn.disabled = true;
    }
  }
}

async function loadContestNamesAsync() {
  // Try cache first
  var cached = loadContestNames();
  if (cached && cached.size > 0) {
    contestNames = cached;
    return;
  }
  // Fetch from API
  try {
    var map = await fetchContestNames();
    contestNames = map;
    saveContestNames(map);
  } catch (e) {
    console.warn("Failed to load contest names:", e);
  }
}

function onDataReady() {
  dom.rollBtn.disabled = false;
  renderTagChips();
  updateProblemCount();
  history = loadHistory();
  renderHistory();

  // Try to auto-load solved data for previously used handle
  var prevHandle = cfHandle.trim();
  if (prevHandle) {
    loadUserData(prevHandle, false);
  }
}

// =============================================
// 6. HANDLE & SOLVED PROBLEMS
// =============================================

async function loadUserData(handle, showStatus) {
  if (!handle || submissionsLoading) return;

  // Check cache first
  var cachedSolved = loadSolvedCache(handle);
  var cachedSubs = loadSubmissionsCache(handle);

  if (cachedSolved && cachedSubs) {
    solvedProblemIds = new Set(cachedSolved.solvedIds);
    userSubmissions = cachedSubs;
    cfHandle = handle;
    dom.excludeSolved.disabled = false;
    dom.excludeHandleName.textContent = handle;
    if (showStatus) {
      setHandleStatus("success", "Loaded " + solvedProblemIds.size + " solved problems (cached)");
    }
    updateProblemCount();
    updateRollButton();
    renderHistory();
    if (currentTab === "stats") {
      renderStats();
    } else if (currentTab === "contests") {
      renderContests();
    }
    return;
  }

  // Fetch from API
  submissionsLoading = true;
  if (showStatus) setHandleStatus("loading", "Fetching submissions...");
  dom.excludeSolved.disabled = true;

  try {
    var result = await fetchUserSubmissions(handle);
    solvedProblemIds = result.solvedIds;
    userSubmissions = result.submissions;
    cfHandle = handle;

    saveSolvedCache(handle, solvedProblemIds, userSubmissions);
    dom.excludeSolved.disabled = false;
    dom.excludeHandleName.textContent = handle;

    if (showStatus) {
      setHandleStatus("success", "Loaded " + solvedProblemIds.size + " solved problems");
    }

    submissionsLoading = false;
    updateProblemCount();
    updateRollButton();
    renderHistory();
    if (currentTab === "stats") {
      renderStats();
    } else if (currentTab === "contests") {
      renderContests();
    }
  } catch (e) {
    submissionsLoading = false;
    console.error("Failed to fetch user submissions:", e);
    if (showStatus) {
      setHandleStatus("error", "Failed: " + e.message);
    }
    dom.excludeSolved.disabled = true;
  }
}

function setHandleStatus(type, message) {
  dom.handleStatus.textContent = message;
  dom.handleStatus.className = "handle-status " + type;
}

// =============================================
// 7. FILTERING
// =============================================

function getMatchingProblems() {
  return allProblems.filter(function (p) {
    // Rating filter
    if (p.rating === 0) {
      if (ratingMin > 0 || ratingMax < 3500) return false;
    } else {
      if (p.rating < ratingMin || p.rating > ratingMax) return false;
    }

    // Tag filter (OR logic)
    if (selectedTags.size > 0) {
      var hasTag = false;
      for (var i = 0; i < p.tags.length; i++) {
        if (selectedTags.has(p.tags[i])) {
          hasTag = true;
          break;
        }
      }
      if (!hasTag) return false;
    }

    // Kotlin exclusion
    if (excludeKotlin && KOTLIN_CONTESTS.has(p.contestId)) {
      return false;
    }

    // Min contest ID
    if (p.contestId < minContestId) {
      return false;
    }

    // Solved exclusion
    if (excludeSolved && solvedProblemIds.size > 0) {
      var key = p.contestId + ":" + p.index;
      if (solvedProblemIds.has(key)) return false;
    }

    return true;
  });
}

function updateProblemCount() {
  var matching = getMatchingProblems();
  dom.problemCount.innerHTML =
    'Matching: <span class="highlight">' +
    matching.length.toLocaleString() +
    "</span> of " +
    allProblems.length.toLocaleString() +
    " problems";
}

// =============================================
// 8. CF RATING COLOR
// =============================================

function getRatingColor(rating) {
  if (rating < 1200) return "#808080";
  if (rating < 1400) return "#008000";
  if (rating < 1600) return "#03a89e";
  if (rating < 1900) return "#0000ff";
  if (rating < 2100) return "#aa00aa";
  if (rating < 2400) return "#ff8c00";
  return "#ff0000";
}

function getRatingTitle(rating) {
  if (rating === 0) return "Unrated";
  if (rating < 1200) return "Newbie";
  if (rating < 1400) return "Pupil";
  if (rating < 1600) return "Specialist";
  if (rating < 1900) return "Expert";
  if (rating < 2100) return "Candidate Master";
  if (rating < 2300) return "Master";
  if (rating < 2400) return "International Master";
  if (rating < 2600) return "Grandmaster";
  if (rating < 3000) return "International Grandmaster";
  return "Legendary Grandmaster";
}

// =============================================
// 9. RENDERING — PICKER
// =============================================

function renderTagChips() {
  var tagSet = new Set();
  allProblems.forEach(function (p) {
    p.tags.forEach(function (t) { tagSet.add(t); });
  });
  var allTags = Array.from(tagSet).sort();
  var searchText = dom.tagSearch.value.trim().toLowerCase();

  var html = "";
  allTags.forEach(function (tag) {
    if (searchText && tag.toLowerCase().indexOf(searchText) === -1) return;
    var isSelected = selectedTags.has(tag);
    html +=
      '<span class="tag-chip' + (isSelected ? " selected" : "") +
      '" data-tag="' + escapeHtml(tag) + '" title="' + escapeHtml(tag) + '">' + escapeHtml(shortenTag(tag)) + "</span>";
  });

  if (!html) {
    html = '<span class="text-muted" style="padding:8px 0;display:block;">No tags match your search.</span>';
  }

  dom.tagContainer.innerHTML = html;
  updateProblemCount();
  updateRollButton();
}

function renderProblemCard(problem) {
  var color = getRatingColor(problem.rating);
  var tagsHtml = problem.tags.map(function (t) {
    return '<span class="card-tag">' + escapeHtml(t) + "</span>";
  }).join("\n");

  var ratingDisplay = problem.rating > 0 ? problem.rating : "?";
  var ratingTitle = getRatingTitle(problem.rating);
  var cfUrl = "https://codeforces.com/problemset/problem/" + problem.contestId + "/" + problem.index;

  dom.problemCard.innerHTML =
    '<div class="card-header">' +
    '<span class="card-id">' + problem.contestId + problem.index + "</span>" +
    '<span class="rating-badge" style="background:' + color + ';" title="' + ratingTitle + '">★ ' + ratingDisplay + "</span>" +
    "</div>" +
    '<h3 class="card-title">' + escapeHtml(problem.name) + "</h3>" +
    '<div class="card-tags">' + tagsHtml + "</div>" +
    '<p class="card-solved">Solved by <strong>' + problem.solvedCount.toLocaleString() + "</strong> users" +
    (solvedProblemIds.size > 0 && solvedProblemIds.has(problem.contestId + ":" + problem.index)
      ? ' · <span class="card-you-solved">✓ You solved this</span>' : "") +
    "</p>" +
    '<div class="card-actions">' +
    '<a href="' + cfUrl + '" target="_blank" rel="noopener noreferrer" class="btn-open-cf">Open in Codeforces ↗</a>' +
    '<button class="btn-roll-again" id="rollAgainBtn">🎲 Roll Again</button>' +
    "</div>";

  dom.problemCard.classList.add("just-rolled");
  setTimeout(function () { dom.problemCard.classList.remove("just-rolled"); }, 400);

  var rollAgainBtn = $("#rollAgainBtn");
  if (rollAgainBtn) {
    rollAgainBtn.addEventListener("click", rollRandomProblem);
  }
}

function renderHistory() {
  if (history.length === 0) {
    dom.historyList.innerHTML = '<p class="text-muted">No problems rolled yet.</p>';
    dom.clearHistoryBtn.hidden = true;
    return;
  }

  var html = "";
  history.forEach(function (problem, idx) {
    var color = getRatingColor(problem.rating);
    var ratingDisplay = problem.rating > 0 ? problem.rating : "?";
    var tagsHtml = problem.tags.slice(0, 3).map(function (t) {
      return '<span class="history-tag">' + escapeHtml(t) + "</span>";
    }).join("");
    if (problem.tags.length > 3) {
      tagsHtml += '<span class="history-tag">+' + (problem.tags.length - 3) + "</span>";
    }

    html +=
      '<div class="history-item" data-idx="' + idx + '" title="Open in Codeforces (new tab)">' +
      '<span class="history-num">' + (idx + 1) + ".</span>" +
      '<span class="history-id">' + problem.contestId + problem.index + "</span>" +
      '<span class="history-name">' + escapeHtml(problem.name) + "</span>" +
      '<span class="history-rating" style="background:' + color + '">' + ratingDisplay + "</span>" +
      '<span class="history-tags">' + tagsHtml + "</span>" +
      '<span class="history-link-icon">↗</span>' +
      '<button class="history-delete" data-idx="' + idx + '" title="Remove from history">×</button>' +
      "</div>";
  });

  dom.historyList.innerHTML = html;
  dom.clearHistoryBtn.hidden = false;
}

// =============================================
// 10. RANDOM ROLL
// =============================================

function rollRandomProblem() {
  var matching = getMatchingProblems();
  if (matching.length === 0) return;

  var picked = null;
  var attempts = 0;
  while (attempts < 10 && matching.length > 1) {
    var idx = Math.floor(Math.random() * matching.length);
    picked = matching[idx];
    if (
      history.length === 0 ||
      history[0].contestId !== picked.contestId ||
      history[0].index !== picked.index
    ) {
      break;
    }
    attempts++;
  }
  if (!picked) {
    picked = matching[Math.floor(Math.random() * matching.length)];
  }

  currentProblem = picked;
  dom.problemCardSection.hidden = false;
  renderProblemCard(picked);

  if (
    history.length === 0 ||
    history[0].contestId !== picked.contestId ||
    history[0].index !== picked.index
  ) {
    history.unshift({
      contestId: picked.contestId,
      index: picked.index,
      name: picked.name,
      rating: picked.rating,
      tags: picked.tags.slice(),
    });
    if (history.length > MAX_HISTORY) {
      history = history.slice(0, MAX_HISTORY);
    }
    saveHistory(history);
    renderHistory();
  }

  dom.problemCardSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

// =============================================
// 11. TAB SWITCHING
// =============================================

function switchTab(tabName) {
  currentTab = tabName;

  dom.tabBtns.forEach(function (btn) {
    if (btn.dataset.tab === tabName) {
      btn.classList.add("tab-active");
    } else {
      btn.classList.remove("tab-active");
    }
  });

  dom.pickerPage.hidden = tabName !== "picker";
  dom.statsPage.hidden = tabName !== "stats";
  dom.contestsPage.hidden = tabName !== "contests";

  if (tabName === "stats") {
    renderStats();
  } else if (tabName === "contests") {
    contestsPage = 1;
    renderContests();
  }
}

// =============================================
// 12. STATS RENDERING
// =============================================

function renderStats() {
  var handle = cfHandle.trim();

  if (!handle) {
    dom.statsContent.innerHTML =
      '<div class="stats-placeholder">' +
      '<p>Enter your Codeforces handle above and press <strong>Enter</strong> to load your stats.</p>' +
      "</div>";
    return;
  }

  if (!userSubmissions.length && !submissionsLoading) {
    dom.statsContent.innerHTML =
      '<div class="stats-placeholder">' +
      '<p>Loading submissions for <strong>' + escapeHtml(handle) + "</strong>...</p>" +
      "</div>";
    loadUserData(handle, true);
    return;
  }

  if (submissionsLoading) {
    dom.statsContent.innerHTML =
      '<div class="stats-loading">' +
      '<div class="spinner"></div>' +
      '<p>Fetching submissions for <strong>' + escapeHtml(handle) + "</strong>...</p>" +
      "</div>";
    return;
  }

  // Build solved problems list from submissions
  var solvedMap = new Map(); // "contestId:index" → { problem, solvedCount }
  userSubmissions.forEach(function (sub) {
    if (sub.verdict === "OK" && sub.problem) {
      var key = sub.problem.contestId + ":" + sub.problem.index;
      if (!solvedMap.has(key)) {
        solvedMap.set(key, {
          contestId: sub.problem.contestId,
          index: sub.problem.index,
          name: sub.problem.name,
          rating: sub.problem.rating || 0,
          tags: sub.problem.tags,
        });
      }
    }
  });

  var solvedProblems = Array.from(solvedMap.values());
  // Sort by rating desc
  solvedProblems.sort(function (a, b) { return b.rating - a.rating; });

  var html = "";

  // --- Summary Cards ---
  var ratedProblems = solvedProblems.filter(function (p) { return p.rating > 0; });
  var avgRating = ratedProblems.length > 0
    ? Math.round(ratedProblems.reduce(function (s, p) { return s + p.rating; }, 0) / ratedProblems.length)
    : 0;
  var maxRating = solvedProblems.length > 0 ? solvedProblems[0].rating : 0;

  var allTags = new Set();
  solvedProblems.forEach(function (p) { p.tags.forEach(function (t) { allTags.add(t); }); });

  html += '<div class="summary-cards">';
  html += buildSummaryCard(solvedProblems.length, "Problems Solved");
  html += buildSummaryCard(avgRating, "Average Rating", getRatingColor(avgRating));
  html += buildSummaryCard(maxRating, "Max Rating Solved", getRatingColor(maxRating));
  html += buildSummaryCard(allTags.size, "Unique Tags");
  html += "</div>";

  // --- Rating Distribution ---
  html += buildRatingChart(solvedProblems);

  // --- Tag Distribution ---
  html += buildTagDistribution(solvedProblems);

  // --- Solved Table ---
  html += buildSolvedTable(solvedProblems);

  dom.statsContent.innerHTML = html;

  // Animate bars from 0 to target size
  setTimeout(function () {
    $$(".anim-init").forEach(function (el) {
      el.classList.remove("anim-init");
    });
  }, 50);

  // Bind table events
  bindStatsEvents(solvedProblems);
}

function buildSummaryCard(value, label, color) {
  return '<div class="summary-card">' +
    '<div class="card-value"' + (color ? ' style="color:' + color + '"' : "") + '>' + value + "</div>" +
    '<div class="card-label">' + escapeHtml(label) + "</div>" +
    "</div>";
}

function buildRatingChart(solvedProblems) {
  var ranges = [
    { label: "<1200", min: 1, max: 1199, color: "#808080" },
    { label: "1200-1399", min: 1200, max: 1399, color: "#008000" },
    { label: "1400-1599", min: 1400, max: 1599, color: "#03a89e" },
    { label: "1600-1899", min: 1600, max: 1899, color: "#0000ff" },
    { label: "1900-2099", min: 1900, max: 2099, color: "#aa00aa" },
    { label: "2100-2399", min: 2100, max: 2399, color: "#ff8c00" },
    { label: "2400+", min: 2400, max: 9999, color: "#ff0000" },
  ];

  var counts = ranges.map(function (r) {
    return solvedProblems.filter(function (p) {
      return p.rating > 0 && p.rating >= r.min && p.rating <= r.max;
    }).length;
  });

  var maxCount = Math.max.apply(null, counts);
  if (maxCount === 0) maxCount = 1;

  var html = '<div class="stats-section"><h3>Rating Distribution</h3>';
  html += '<div class="rating-chart">';

  ranges.forEach(function (r, i) {
    var h = Math.max(4, Math.round((counts[i] / maxCount) * 160));
    html += '<div class="rating-bar-wrapper">';
    html += '<span class="rating-bar-count">' + counts[i] + "</span>";
    html += '<div class="rating-bar anim-init" style="height:' + h + 'px; background:' + r.color + ';"></div>';
    html += '<span class="rating-bar-label">' + r.label + "</span>";
    html += "</div>";
  });

  html += "</div></div>";
  return html;
}

function buildTagDistribution(solvedProblems) {
  var tagCounts = new Map();
  solvedProblems.forEach(function (p) {
    p.tags.forEach(function (t) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    });
  });

  var sorted = Array.from(tagCounts.entries()).sort(function (a, b) {
    return b[1] - a[1];
  });

  var maxCount = sorted.length > 0 ? sorted[0][1] : 1;

  var html = '<div class="stats-section"><h3>Tag Distribution</h3>';
  html += '<div class="tag-dist-list">';

  sorted.forEach(function (entry, i) {
    var tag = entry[0];
    var count = entry[1];
    var pct = Math.round((count / maxCount) * 100);
    html += '<div class="tag-dist-item">';
    html += '<span class="tag-dist-name" title="' + escapeHtml(tag) + '">' + escapeHtml(shortenTag(tag)) + "</span>";
    html += '<div class="tag-dist-bar-wrapper">';
    html += '<div class="tag-dist-bar anim-init" style="width:' + pct + '%;"></div>';
    html += "</div>";
    html += '<span class="tag-dist-count">' + count + "</span>";
    html += "</div>";
  });

  html += "</div></div>";
  return html;
}

function buildSolvedTable(solvedProblems) {
  var html = '<div class="stats-section"><h3>Solved Problems (' + solvedProblems.length + ")</h3>";

  html += '<div class="solved-table-controls">';
  html += '<input type="text" id="statsTableSearch" placeholder="Search by name or tag...">';
  html += '<select id="statsTableSort">';
  html += '<option value="rating-desc">Rating ↓</option>';
  html += '<option value="rating-asc">Rating ↑</option>';
  html += '<option value="name-asc">Name A-Z</option>';
  html += '<option value="name-desc">Name Z-A</option>';
  html += "</select>";
  html += "</div>";

  html += '<div class="solved-table-wrapper">';
  html += '<table class="solved-table">';
  html += "<thead><tr>";
  html += '<th data-sort="id">ID</th>';
  html += '<th data-sort="name">Name</th>';
  html += '<th data-sort="rating">Rating</th>';
  html += "<th>Tags</th>";
  html += "</tr></thead>";
  html += '<tbody id="statsTableBody">';

  solvedProblems.forEach(function (p) {
    var color = getRatingColor(p.rating);
    var ratingDisplay = p.rating > 0 ? p.rating : "?";
    var tagsHtml = p.tags.map(function (t) {
      return '<span class="st-tag">' + escapeHtml(t) + "</span>";
    }).join("");

    html += '<tr data-contest="' + p.contestId + '" data-index="' + p.index + '" title="Open in Codeforces (new tab)">';
    html += '<td class="st-id">' + p.contestId + p.index + "</td>";
    html += "<td>" + escapeHtml(p.name) + "</td>";
    html += '<td><span class="st-rating" style="background:' + color + '">' + ratingDisplay + "</span></td>";
    html += '<td><div class="st-tags">' + tagsHtml + "</div></td>";
    html += "</tr>";
  });

  html += "</tbody></table></div></div>";
  return html;
}

function bindStatsEvents(originalProblems) {
  // Table row click → open CF
  var tbody = document.getElementById("statsTableBody");
  if (tbody) {
    tbody.addEventListener("click", function (e) {
      var tr = e.target.closest("tr");
      if (!tr) return;
      var contestId = tr.dataset.contest;
      var index = tr.dataset.index;
      if (contestId && index) {
        window.open(
          "https://codeforces.com/problemset/problem/" + contestId + "/" + index,
          "_blank", "noopener,noreferrer"
        );
      }
    });
  }

  // Search
  var searchInput = document.getElementById("statsTableSearch");
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      filterAndSortTable(originalProblems);
    });
  }

  // Sort
  var sortSelect = document.getElementById("statsTableSort");
  if (sortSelect) {
    sortSelect.addEventListener("change", function () {
      filterAndSortTable(originalProblems);
    });
  }
}

function filterAndSortTable(originalProblems) {
  var searchInput = document.getElementById("statsTableSearch");
  var sortSelect = document.getElementById("statsTableSort");

  var searchText = searchInput ? searchInput.value.trim().toLowerCase() : "";
  var sortBy = sortSelect ? sortSelect.value : "rating-desc";

  var filtered = originalProblems.filter(function (p) {
    if (!searchText) return true;
    var nameMatch = p.name.toLowerCase().indexOf(searchText) !== -1;
    var tagMatch = p.tags.some(function (t) { return t.toLowerCase().indexOf(searchText) !== -1; });
    var idMatch = (p.contestId + p.index).toLowerCase().indexOf(searchText) !== -1;
    return nameMatch || tagMatch || idMatch;
  });

  if (sortBy === "rating-desc") {
    filtered.sort(function (a, b) { return b.rating - a.rating; });
  } else if (sortBy === "rating-asc") {
    filtered.sort(function (a, b) { return a.rating - b.rating; });
  } else if (sortBy === "name-asc") {
    filtered.sort(function (a, b) { return a.name.localeCompare(b.name); });
  } else if (sortBy === "name-desc") {
    filtered.sort(function (a, b) { return b.name.localeCompare(a.name); });
  }

  // Re-render table body
  var tbody = document.getElementById("statsTableBody");
  if (!tbody) return;

  var html = "";
  filtered.forEach(function (p) {
    var color = getRatingColor(p.rating);
    var ratingDisplay = p.rating > 0 ? p.rating : "?";
    var tagsHtml = p.tags.map(function (t) {
      return '<span class="st-tag">' + escapeHtml(t) + "</span>";
    }).join("");

    html += '<tr data-contest="' + p.contestId + '" data-index="' + p.index + '" title="Open in Codeforces (new tab)">';
    html += '<td class="st-id">' + p.contestId + p.index + "</td>";
    html += "<td>" + escapeHtml(p.name) + "</td>";
    html += '<td><span class="st-rating" style="background:' + color + '">' + ratingDisplay + "</span></td>";
    html += '<td><div class="st-tags">' + tagsHtml + "</div></td>";
    html += "</tr>";
  });

  if (!html) {
    html = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:20px;">No problems match.</td></tr>';
  }

  tbody.innerHTML = html;
}

// =============================================
// 13. CONTESTS RENDERING
// =============================================

function getContestGroups() {
  var groups = new Map();
  allProblems.forEach(function (p) {
    if (!groups.has(p.contestId)) {
      groups.set(p.contestId, []);
    }
    groups.get(p.contestId).push(p);
  });
  // Sort problems within each contest by index
  groups.forEach(function (probs) {
    probs.sort(function (a, b) {
      if (a.index.length !== b.index.length) return a.index.length - b.index.length;
      return a.index.localeCompare(b.index);
    });
  });
  // Sort contests by ID descending (newest first)
  var entries = Array.from(groups.entries());
  entries.sort(function (a, b) { return b[0] - a[0]; });
  return entries;
}

function renderContests() {
  if (!allProblems.length) {
    dom.contestsContent.innerHTML =
      '<div class="stats-placeholder"><p>Problem data not loaded yet.</p></div>';
    return;
  }

  var searchText = dom.contestsSearch.value.trim().toLowerCase();
  var entries = getContestGroups();

  // Build filtered list first (all matching contests)
  var filteredEntries = [];
  entries.forEach(function (entry) {
    var contestId = entry[0];
    var problems = entry[1];

    var filtered = problems;
    if (searchText) {
      filtered = problems.filter(function (p) {
        return (String(contestId) + " " + p.name + " " + p.index + " " + p.tags.join(" ")).toLowerCase().indexOf(searchText) !== -1;
      });
    }
    if (!filtered.length) return;

    filteredEntries.push({ contestId: contestId, problems: filtered });
  });

  var totalContests = filteredEntries.length;
  var totalPages = Math.ceil(totalContests / CONTESTS_PAGE_SIZE);
  if (contestsPage > totalPages) contestsPage = totalPages;
  if (contestsPage < 1) contestsPage = 1;

  // Slice for current page
  var start = (contestsPage - 1) * CONTESTS_PAGE_SIZE;
  var pageEntries = filteredEntries.slice(start, start + CONTESTS_PAGE_SIZE);

  var html = "";

  // Build pagination nav
  html += buildPagination(totalContests, totalPages);

  if (!pageEntries.length) {
    html += '<div class="stats-placeholder"><p>No contests match your search.</p></div>';
    dom.contestsContent.innerHTML = html;
    bindPagination();
    return;
  }

  pageEntries.forEach(function (entry) {
    var contestId = entry.contestId;
    var problems = entry.problems;

    // Build problem rows
    var rowsHtml = "";
    var hasSolvedData = solvedProblemIds.size > 0;
    problems.forEach(function (p) {
      var color = getRatingColor(p.rating);
      var ratingDisplay = p.rating > 0 ? p.rating : "?";
      var tagsHtml = p.tags.map(function (t) {
        return '<span class="ct-tag">' + escapeHtml(t) + "</span>";
      }).join("");

      var solvedClass = "";
      if (hasSolvedData && solvedProblemIds.has(p.contestId + ":" + p.index)) {
        solvedClass = " ct-solved";
      }

      rowsHtml +=
        '<a class="ct-problem' + solvedClass + '" href="https://codeforces.com/problemset/problem/' + p.contestId + '/' + p.index + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="ct-index">' + p.index + "</span>" +
        '<span class="ct-name">' + escapeHtml(p.name) + "</span>" +
        '<span class="ct-rating" style="background:' + color + '">' + ratingDisplay + "</span>" +
        '<span class="ct-tags">' + tagsHtml + "</span>" +
        "</a>";
    });

    var contestName = contestNames.get(contestId) || ("Contest " + contestId);

    html +=
      '<div class="ct-contest">' +
      '<button class="ct-header" data-contest="' + contestId + '">' +
      '<span class="ct-contest-id">' + escapeHtml(contestName) + "</span>" +
      '<span class="ct-contest-count">' + problems.length + " problem" + (problems.length !== 1 ? "s" : "") + "</span>" +
      '<span class="ct-arrow">▾</span>' +
      "</button>" +
      '<div class="ct-problems" id="ct-problems-' + contestId + '">' +
      rowsHtml +
      "</div>" +
      "</div>";
  });

  // Bottom pagination
  html += buildPagination(totalContests, totalPages);

  dom.contestsContent.innerHTML = html;

  // Bind contest header clicks (expand/collapse)
  dom.contestsContent.querySelectorAll(".ct-header").forEach(function (header) {
    header.addEventListener("click", function () {
      var cid = header.dataset.contest;
      var problemsDiv = document.getElementById("ct-problems-" + cid);
      if (problemsDiv) {
        problemsDiv.classList.toggle("ct-collapsed");
        header.classList.toggle("ct-collapsed");
      }
    });
  });

  // Bind pagination buttons
  bindPagination();
}

function buildPagination(totalContests, totalPages) {
  if (totalPages <= 1) return "";

  var html = '<div class="ct-pagination">';
  html += '<span class="ct-page-info">' + totalContests + " contest" + (totalContests !== 1 ? "s" : "") + " · Page " + contestsPage + " of " + totalPages + "</span>";
  html += '<div class="ct-page-btns">';
  html += '<button class="ct-page-btn" data-page="1"' + (contestsPage <= 1 ? " disabled" : "") + '>First</button>';
  html += '<button class="ct-page-btn" data-page="' + (contestsPage - 1) + '"' + (contestsPage <= 1 ? " disabled" : "") + '>← Prev</button>';
  html += '<button class="ct-page-btn" data-page="' + (contestsPage + 1) + '"' + (contestsPage >= totalPages ? " disabled" : "") + '>Next →</button>';
  html += '<button class="ct-page-btn" data-page="' + totalPages + '"' + (contestsPage >= totalPages ? " disabled" : "") + '>Last</button>';
  html += "</div></div>";
  return html;
}

function bindPagination() {
  dom.contestsContent.querySelectorAll(".ct-page-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var page = parseInt(btn.dataset.page, 10);
      if (isNaN(page)) return;
      contestsPage = page;
      renderContests();
      dom.contestsContent.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

// =============================================
// 14. UI HELPERS
// =============================================

function showLoading(show) {
  dom.loadingOverlay.hidden = !show;
  dom.filtersSection.style.opacity = show ? "0.4" : "1";
  dom.filtersSection.style.pointerEvents = show ? "none" : "auto";
}

function showError(message, isPersistent) {
  dom.errorBanner.hidden = false;
  dom.errorBanner.innerHTML =
    escapeHtml(message) +
    (isPersistent ? ' <button class="btn-retry" onclick="location.reload()">Retry</button>' : "");
}

function hideError() {
  dom.errorBanner.hidden = true;
}

function showCacheStatus(message) {
  dom.cacheStatus.hidden = false;
  dom.cacheStatus.innerHTML = message;
}

function hideCacheStatus() {
  dom.cacheStatus.hidden = true;
}

function updateRollButton() {
  var matching = getMatchingProblems();
  dom.rollBtn.disabled = matching.length === 0;
}

function formatTimeAgo(ms) {
  var minutes = Math.floor(ms / 60000);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);
  if (days > 0) return days + " day" + (days > 1 ? "s" : "");
  if (hours > 0) return hours + " hour" + (hours > 1 ? "s" : "");
  if (minutes > 0) return minutes + " minute" + (minutes > 1 ? "s" : "");
  return "less than a minute";
}

function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// =============================================
// 14. EVENT HANDLERS
// =============================================

function onTagClick(e) {
  var chip = e.target.closest(".tag-chip");
  if (!chip) return;
  var tag = chip.dataset.tag;
  if (selectedTags.has(tag)) {
    selectedTags.delete(tag);
  } else {
    selectedTags.add(tag);
  }
  renderTagChips();
}

function onPresetClick(e) {
  var btn = e.target.closest(".preset-btn");
  if (!btn) return;
  var minVal = parseInt(btn.dataset.min, 10);
  var maxVal = parseInt(btn.dataset.max, 10);

  $$(".preset-btn").forEach(function (b) { b.classList.remove("preset-active"); });
  btn.classList.add("preset-active");

  dom.ratingMin.value = minVal;
  dom.ratingMax.value = maxVal;
  ratingMin = minVal;
  ratingMax = maxVal;

  updateProblemCount();
  updateRollButton();
}

function onRatingInputLive() {
  var minVal = parseInt(dom.ratingMin.value, 10);
  var maxVal = parseInt(dom.ratingMax.value, 10);
  if (isNaN(minVal) || minVal < 0) minVal = 0;
  if (isNaN(maxVal) || maxVal > 3500) maxVal = 3500;
  ratingMin = minVal;
  ratingMax = maxVal;
  updateProblemCount();
  updateRollButton();
}

function onRatingInputCommit() {
  var minVal = parseInt(dom.ratingMin.value, 10);
  var maxVal = parseInt(dom.ratingMax.value, 10);
  if (isNaN(minVal) || minVal < 0) minVal = 0;
  if (isNaN(maxVal) || maxVal > 3500) maxVal = 3500;
  if (minVal > maxVal) { var tmp = minVal; minVal = maxVal; maxVal = tmp; }
  minVal = Math.round(minVal / 100) * 100;
  maxVal = Math.round(maxVal / 100) * 100;
  dom.ratingMin.value = minVal;
  dom.ratingMax.value = maxVal;
  ratingMin = minVal;
  ratingMax = maxVal;

  $$(".preset-btn").forEach(function (b) {
    var pMin = parseInt(b.dataset.min, 10);
    var pMax = parseInt(b.dataset.max, 10);
    if (pMin === minVal && pMax === maxVal) {
      b.classList.add("preset-active");
    } else {
      b.classList.remove("preset-active");
    }
  });

  updateProblemCount();
  updateRollButton();
}

// =============================================
// 15. EVENT BINDING
// =============================================

// Tab switching
dom.tabBtns.forEach(function (btn) {
  btn.addEventListener("click", function () {
    switchTab(btn.dataset.tab);
  });
});

// Handle input: load on Enter
dom.cfHandle.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    var handle = dom.cfHandle.value.trim();
    if (handle && handle !== cfHandle) {
      loadUserData(handle, true);
      // If user had exclude solved checked, uncheck it since handle changed
      if (excludeSolved && handle !== cfHandle) {
        dom.excludeSolved.checked = false;
        excludeSolved = false;
      }
    }
  }
});

// Handle input: also load on blur if changed
dom.cfHandle.addEventListener("blur", function () {
  var handle = dom.cfHandle.value.trim();
  if (handle && handle !== cfHandle && !submissionsLoading) {
    loadUserData(handle, true);
  }
});

// Exclude solved checkbox
dom.excludeSolved.addEventListener("change", function () {
  excludeSolved = dom.excludeSolved.checked;
  updateProblemCount();
  updateRollButton();
});

// Show tags checkbox
(function () {
  var saved = localStorage.getItem("cf_showTags");
  var showTags = saved === null ? false : saved === "true";
  dom.showTags.checked = showTags;
  document.body.classList.toggle("hide-tags", !showTags);
})();
dom.showTags.addEventListener("change", function () {
  var show = dom.showTags.checked;
  document.body.classList.toggle("hide-tags", !show);
  try { localStorage.setItem("cf_showTags", show); } catch (e) { /* ignore */ }
});

// Min contest ID
dom.minContestId.addEventListener("input", function () {
  var val = parseInt(dom.minContestId.value, 10);
  minContestId = isNaN(val) || val < 0 ? 0 : val;
  updateProblemCount();
  updateRollButton();
});

// Tags
dom.tagContainer.addEventListener("click", onTagClick);
dom.tagSearch.addEventListener("input", function () { renderTagChips(); });
dom.clearTagsBtn.addEventListener("click", function () {
  selectedTags.clear();
  dom.tagSearch.value = "";
  renderTagChips();
  updateRollButton();
});

// Presets
$$(".preset-btn").forEach(function (btn) {
  btn.addEventListener("click", onPresetClick);
});

// Rating inputs
dom.ratingMin.addEventListener("input", onRatingInputLive);
dom.ratingMax.addEventListener("input", onRatingInputLive);
dom.ratingMin.addEventListener("change", onRatingInputCommit);
dom.ratingMax.addEventListener("change", onRatingInputCommit);

// Roll
dom.rollBtn.addEventListener("click", rollRandomProblem);

// History
dom.clearHistoryBtn.addEventListener("click", function () {
  history = [];
  saveHistory(history);
  renderHistory();
});

dom.historyList.addEventListener("click", function (e) {
  // Handle delete button click
  var deleteBtn = e.target.closest(".history-delete");
  if (deleteBtn) {
    e.stopPropagation();
    var delIdx = parseInt(deleteBtn.dataset.idx, 10);
    if (isNaN(delIdx) || delIdx < 0 || delIdx >= history.length) return;
    history.splice(delIdx, 1);
    saveHistory(history);
    renderHistory();
    return;
  }

  // Handle open in CF
  var item = e.target.closest(".history-item");
  if (!item) return;
  var idx = parseInt(item.dataset.idx, 10);
  if (isNaN(idx) || idx < 0 || idx >= history.length) return;
  var problem = history[idx];
  window.open(
    "https://codeforces.com/problemset/problem/" + problem.contestId + "/" + problem.index,
    "_blank", "noopener,noreferrer"
  );
});

// Contests search
dom.contestsSearch.addEventListener("input", function () {
  contestsPage = 1;
  renderContests();
});

// Refresh cache
dom.refreshCacheBtn.addEventListener("click", async function () {
  dom.refreshCacheBtn.disabled = true;
  dom.refreshCacheBtn.textContent = "⏳ Refreshing...";
  hideError();
  hideCacheStatus();
  showLoading(true);

  try {
    var problems = await fetchProblems();
    allProblems = problems;
    cacheTimestamp = Date.now();
    saveCache(problems, cacheTimestamp);
    showLoading(false);
    showCacheStatus("Data refreshed successfully · " + problems.length + " problems loaded.");
    setTimeout(hideCacheStatus, 4000);
    onDataReady();
    // Re-fetch user data if handle is set
    if (cfHandle) {
      loadUserData(cfHandle, false);
    }
  } catch (e) {
    showLoading(false);
    showError("Failed to refresh: " + e.message, true);
  } finally {
    dom.refreshCacheBtn.disabled = false;
    dom.refreshCacheBtn.textContent = "🔄 Refresh Cache";
  }
});

// =============================================
// 16. BOOTSTRAP
// =============================================

document.addEventListener("DOMContentLoaded", function () {
  initProblems();
});
