const bridge = window.vkBridge;

const PERIODS = [
  {
    id: "day",
    label: "За день",
    firstLimit: 6,
    secondLimit: 6,
  },
  {
    id: "week",
    label: "За неделю",
    firstLimit: 9,
    secondLimit: 9,
  },
  {
    id: "month",
    label: "За месяц",
    firstLimit: 12,
    secondLimit: 12,
  },
];

const DEFAULT_AVATAR =
  "https://vk.com/images/camera_200.png";
const CACHE_VERSION = 4;
const RECOMMENDATION_VERSION = 1;

const state = {
  activePeriod: "day",
  user: null,
  firstLevel: [],
  secondLevel: [],
  tabData: {},
  launchParams: {},
  error: "",
  isLoading: false,
  recommendationGranted: false,
};

const elements = {
  heroStatus: document.querySelector("#heroStatus"),
  noticeCard: document.querySelector("#noticeCard"),
  tabsCard: document.querySelector("#tabsCard"),
  tabsTitle: document.querySelector("#tabsTitle"),
  tabsNav: document.querySelector("#tabsNav"),
  tabCaption: document.querySelector("#tabCaption"),
  tabContent: document.querySelector("#tabContent"),
};

function setStatus(message) {
  if (!message) {
    elements.heroStatus.textContent = "";
    elements.heroStatus.classList.add("hidden");
    return;
  }

  elements.heroStatus.textContent = message;
  elements.heroStatus.classList.remove("hidden");
}

function showNotice(message, showRetry = false, retryLabel = "Повторить", actionType = "reload") {
  elements.noticeCard.classList.remove("hidden");
  elements.noticeCard.innerHTML = `
    <p class="notice-text">${escapeHtml(message)}</p>
    ${
      showRetry
        ? `
          <div class="notice-actions">
            <button class="primary-button" type="button" id="retryButton">${escapeHtml(retryLabel)}</button>
          </div>
        `
        : ""
    }
  `;

  const retryButton = document.querySelector("#retryButton");

  if (retryButton) {
    retryButton.addEventListener("click", () => {
      if (actionType === "recommend") {
        handleLockedPeriodClick(state.activePeriod);
        return;
      }

      handleVkLoad(String(state.launchParams.vk_app_id || state.launchParams.app_id || ""));
    });
  }
}

function hideNotice() {
  elements.noticeCard.classList.add("hidden");
  elements.noticeCard.innerHTML = "";
}

function parseLaunchParams() {
  const url = new URL(window.location.href);
  const params = Object.fromEntries(url.searchParams.entries());

  if (window.location.hash.includes("=")) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    for (const [key, value] of hashParams.entries()) {
      if (!(key in params)) {
        params[key] = value;
      }
    }
  }

  return params;
}

function isLikelyVkEnvironment(params) {
  return Boolean(
    params.vk_platform ||
      params.sign ||
      params.vk_app_id ||
      params.app_id
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function makeSeed(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return () => {
    hash += 0x6d2b79f5;
    let t = hash;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleStable(items, limit, seedBase) {
  const rng = makeSeed(seedBase);
  const cloned = [...items];

  for (let index = cloned.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [cloned[index], cloned[swapIndex]] = [cloned[swapIndex], cloned[index]];
  }

  return cloned.slice(0, limit);
}

function mergeNestedSample(allItems, preservedItems, targetCount, seedBase) {
  const preservedIds = new Set(preservedItems.map((item) => item.id));
  const remainingItems = allItems.filter((item) => !preservedIds.has(item.id));
  const extraItems = sampleStable(
    remainingItems,
    Math.max(0, targetCount - preservedItems.length),
    seedBase
  );

  return [...preservedItems, ...extraItems];
}

function getPeriodSeed(periodId) {
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const dayBucket = isoDate;
  const weekBucket = `${now.getUTCFullYear()}-w${Math.ceil(
    (Math.floor(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        Date.UTC(now.getUTCFullYear(), 0, 1)) /
        86400000
    ) +
      new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).getUTCDay() +
      1) /
      7
  )}`;
  const monthBucket = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  if (periodId === "day") {
    return dayBucket;
  }

  if (periodId === "week") {
    return weekBucket;
  }

  return monthBucket;
}

function getCurrentBuckets() {
  return {
    day: getPeriodSeed("day"),
    week: getPeriodSeed("week"),
    month: getPeriodSeed("month"),
  };
}

function getCacheKey(userId) {
  return `vk-guests-cache-v${CACHE_VERSION}-${userId}`;
}

function getRecommendationKey(userId) {
  return `vk-guests-recommend-v${RECOMMENDATION_VERSION}-${userId}`;
}

function isVisibleProfile(person) {
  return !person.deactivated && person.can_access_closed !== false;
}

function getPeriodLimits(firstLevelCount, secondLevelCount) {
  const dayFirst =
    firstLevelCount <= 10
      ? firstLevelCount
      : firstLevelCount <= 40
        ? Math.min(10, Math.max(4, Math.ceil(firstLevelCount * 0.2)))
        : Math.max(10, Math.ceil(firstLevelCount * 0.12));
  const daySecond = Math.min(secondLevelCount, Math.max(3, Math.ceil(secondLevelCount * 0.06)));

  const weekFirst = Math.min(firstLevelCount, Math.max(dayFirst + 3, Math.ceil(firstLevelCount * 0.28)));
  const weekSecond = Math.min(secondLevelCount, Math.max(daySecond + 4, Math.ceil(secondLevelCount * 0.14)));

  const monthFirst = Math.min(firstLevelCount, Math.max(weekFirst + 5, Math.ceil(firstLevelCount * 0.42)));
  const monthSecond = Math.min(secondLevelCount, Math.max(weekSecond + 6, Math.ceil(secondLevelCount * 0.22)));

  return {
    day: { first: dayFirst, second: daySecond },
    week: { first: weekFirst, second: weekSecond },
    month: { first: monthFirst, second: monthSecond },
  };
}

function readCache(userId) {
  try {
    const rawValue = window.localStorage.getItem(getCacheKey(userId));

    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    const currentBuckets = getCurrentBuckets();

    if (
      parsed?.version !== CACHE_VERSION ||
      parsed?.user?.id !== userId ||
      !parsed?.buckets ||
      parsed.buckets.day !== currentBuckets.day ||
      parsed.buckets.week !== currentBuckets.week ||
      parsed.buckets.month !== currentBuckets.month ||
      !parsed?.tabData
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function writeCache(user, tabData) {
  try {
    const payload = {
      version: CACHE_VERSION,
      user,
      buckets: getCurrentBuckets(),
      tabData,
      savedAt: new Date().toISOString(),
    };

    window.localStorage.setItem(getCacheKey(user.id), JSON.stringify(payload));
  } catch {
    // Ignore storage errors and keep app usable.
  }
}

function readRecommendation(userId) {
  try {
    return window.localStorage.getItem(getRecommendationKey(userId)) === "granted";
  } catch {
    return false;
  }
}

function writeRecommendation(userId, isGranted) {
  try {
    window.localStorage.setItem(getRecommendationKey(userId), isGranted ? "granted" : "pending");
  } catch {
    // Ignore storage errors and keep app usable.
  }
}

function normalizePerson(person, layer, sourceFriend = null) {
  const city = person.city?.title || "";
  const photo =
    person.photo_200_orig || person.photo_200 || person.photo_100 || DEFAULT_AVATAR;
  const subtitle = city;

  const normalizedSourceFriend =
    layer === 2 && sourceFriend
      ? {
          name: sourceFriend.name,
          photo: sourceFriend.photo || DEFAULT_AVATAR,
        }
      : null;

  return {
    id: person.id,
    name: `${person.first_name} ${person.last_name}`.trim(),
    photo,
    subtitle,
    sourceFriend: normalizedSourceFriend,
    profileUrl: `https://vk.com/id${person.id}`,
  };
}

async function vkApi(method, params, accessToken, appId) {
  const response = await bridge.send("VKWebAppCallAPIMethod", {
    method,
    params: {
      ...params,
      v: "5.199",
      access_token: accessToken,
    },
    app_id: Number(appId),
  });

  if (response.error) {
    throw new Error(response.error.error_msg || "Ошибка VK API");
  }

  return response.response;
}

async function requestRecommendation() {
  if (!bridge?.send) {
    throw new Error("VK Bridge недоступен.");
  }

  return bridge.send("VKWebAppRecommend");
}

async function initBridge() {
  if (!bridge?.send) {
    setStatus("VK Bridge не найден. Откройте приложение внутри ВКонтакте.");
    return false;
  }

  await bridge.send("VKWebAppInit");
  return true;
}

async function loadVkData(appId) {
  const bridgeReady = await initBridge();

  if (!bridgeReady) {
    throw new Error("VK Bridge недоступен в этой среде.");
  }

  const [launchParams, userInfo] = await Promise.all([
    bridge.send("VKWebAppGetLaunchParams"),
    bridge.send("VKWebAppGetUserInfo"),
  ]);

  state.launchParams = launchParams;
  const effectiveAppId = appId || launchParams.vk_app_id || launchParams.app_id;

  if (!effectiveAppId) {
    throw new Error("Не удалось получить параметры запуска приложения из ВКонтакте.");
  }

  const cachedData = readCache(userInfo.id);

  if (cachedData) {
    return {
      user: cachedData.user,
      firstLevel: [],
      secondLevel: [],
      tabData: cachedData.tabData,
      recommendationGranted: readRecommendation(userInfo.id),
    };
  }

  const authTokenResponse = await bridge.send("VKWebAppGetAuthToken", {
    app_id: Number(effectiveAppId),
    scope: "friends",
  });

  const accessToken = authTokenResponse.access_token;

  if (!accessToken) {
    throw new Error("Приложение не получило токен с правами friends.");
  }

  const friendsResponse = await vkApi(
    "friends.get",
    {
      order: "hints",
      fields: "city,photo_100,photo_200,photo_200_orig,can_access_closed",
      count: 5000,
    },
    accessToken,
    effectiveAppId
  );

  const firstLevelFriends = (friendsResponse.items || [])
    .filter((friend) => isVisibleProfile(friend))
    .map((friend) => normalizePerson(friend, 1));

  const seedBase = `${userInfo.id}-${new Date().toISOString().slice(0, 7)}`;
  const secondLevelInput = sampleStable(
    friendsResponse.items || [],
    Math.min(20, friendsResponse.items?.length || 0),
    seedBase
  );

  const secondLevelChunks = await Promise.allSettled(
    secondLevelInput.map((friend) =>
      vkApi(
        "friends.get",
        {
          user_id: friend.id,
          fields: "city,photo_100,photo_200,photo_200_orig,can_access_closed",
          count: 100,
        },
        accessToken,
        effectiveAppId
      ).then((response) => ({
        response,
        sourceFriend: {
          name: `${friend.first_name} ${friend.last_name}`.trim(),
          photo: friend.photo_200_orig || friend.photo_200 || friend.photo_100 || DEFAULT_AVATAR,
        },
      }))
    )
  );

  const secondLevelMap = new Map();
  const firstLevelIds = new Set(firstLevelFriends.map((person) => person.id));

  secondLevelChunks.forEach((result) => {
    if (result.status !== "fulfilled") {
      return;
    }

    const items = result.value.response.items || [];
    const { sourceFriend } = result.value;

    items.forEach((person) => {
      if (
        person.id === userInfo.id ||
        firstLevelIds.has(person.id) ||
        secondLevelMap.has(person.id) ||
        !isVisibleProfile(person)
      ) {
        return;
      }

      secondLevelMap.set(person.id, normalizePerson(person, 2, sourceFriend));
    });
  });

  return {
    user: {
      id: userInfo.id,
      first_name: userInfo.first_name,
      last_name: userInfo.last_name,
      photo_200: userInfo.photo_200 || userInfo.photo_100 || DEFAULT_AVATAR,
    },
    firstLevel: firstLevelFriends,
    secondLevel: [...secondLevelMap.values()],
    recommendationGranted: readRecommendation(userInfo.id),
  };
}

function buildTabData() {
  const limits = getPeriodLimits(state.firstLevel.length, state.secondLevel.length);
  const dayBucket = getPeriodSeed("day");
  const weekBucket = getPeriodSeed("week");
  const monthBucket = getPeriodSeed("month");
  const userSeed = `${state.user?.id || "guest"}`;

  const dayFirstLevel = sampleStable(
    state.firstLevel,
    limits.day.first,
    `${userSeed}-day-${dayBucket}-f1`
  );
  const daySecondLevel = sampleStable(
    state.secondLevel,
    limits.day.second,
    `${userSeed}-day-${dayBucket}-f2`
  );

  const weekFirstLevel = mergeNestedSample(
    state.firstLevel,
    dayFirstLevel,
    limits.week.first,
    `${userSeed}-week-${weekBucket}-f1`
  );
  const weekSecondLevel = mergeNestedSample(
    state.secondLevel,
    daySecondLevel,
    limits.week.second,
    `${userSeed}-week-${weekBucket}-f2`
  );

  const monthFirstLevel = mergeNestedSample(
    state.firstLevel,
    weekFirstLevel,
    limits.month.first,
    `${userSeed}-month-${monthBucket}-f1`
  );
  const monthSecondLevel = mergeNestedSample(
    state.secondLevel,
    weekSecondLevel,
    limits.month.second,
    `${userSeed}-month-${monthBucket}-f2`
  );

  state.tabData = {
    day: {
      firstLevel: dayFirstLevel,
      secondLevel: daySecondLevel,
      label: "За день",
    },
    week: {
      firstLevel: weekFirstLevel,
      secondLevel: weekSecondLevel,
      label: "За неделю",
    },
    month: {
      firstLevel: monthFirstLevel,
      secondLevel: monthSecondLevel,
      label: "За месяц",
    },
  };
}

function renderTabsHeader() {
  if (!state.user) {
    elements.tabsTitle.innerHTML = `<h2>Ваши гости</h2>`;
    return;
  }

  elements.tabsTitle.innerHTML = `
    <img
      class="tabs-user-photo"
      src="${escapeHtml(state.user.photo_200)}"
      alt="${escapeHtml(state.user.first_name)}"
    />
    <div>
      <h2>Ваши гости</h2>
      <div class="tabs-user-name">${escapeHtml(state.user.first_name)} ${escapeHtml(state.user.last_name)}</div>
    </div>
  `;
}

function renderTabsNav() {
  elements.tabsNav.innerHTML = PERIODS.map(
    (period) => `
      <button
        class="tab-button ${period.id === state.activePeriod ? "active" : ""}"
        type="button"
        data-period="${period.id}"
      >
        ${period.label}
      </button>
    `
  ).join("");

  elements.tabsNav.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      const periodId = button.dataset.period;

      if ((periodId === "week" || periodId === "month") && !state.recommendationGranted) {
        handleLockedPeriodClick(periodId);
        return;
      }

      state.activePeriod = periodId;
      hideNotice();
      renderTabs();
    });
  });
}

async function handleLockedPeriodClick(periodId) {
  state.activePeriod = periodId;

  if (!isLikelyVkEnvironment(state.launchParams)) {
    showNotice("Откройте приложение во ВКонтакте.", false);
    return;
  }

  try {
    await requestRecommendation();
    state.recommendationGranted = true;

    if (state.user?.id) {
      writeRecommendation(state.user.id, true);
    }

    hideNotice();
    renderTabs();
  } catch (error) {
    const periodLabel = periodId === "week" ? "за неделю" : "за месяц";
    showNotice(`Чтобы посмотреть гостей ${periodLabel}, порекомендуйте наше приложение.`);
  }
}

function renderPeopleList(people) {
  if (!people.length) {
    return `
      <div class="empty-state">
        Здесь пока нет карточек. У некоторых пользователей список друзей закрыт, поэтому
        друзей второго уровня может быть меньше.
      </div>
    `;
  }

  return `
    <div class="people-list">
      ${people
        .map(
          (person) => `
            <a class="person" href="${escapeHtml(person.profileUrl)}" target="_blank" rel="noreferrer">
              <img src="${escapeHtml(person.photo)}" alt="${escapeHtml(person.name)}" />
              <div>
                <div class="person-name">${escapeHtml(person.name)}</div>
                ${
                  person.subtitle
                    ? `<div class="meta">${escapeHtml(person.subtitle)}</div>`
                    : ""
                }
                ${
                  person.sourceFriend
                    ? `
                      <div class="source-friend">
                        <img
                          class="source-friend-photo"
                          src="${escapeHtml(person.sourceFriend.photo)}"
                          alt="${escapeHtml(person.sourceFriend.name)}"
                        />
                        <span class="source-friend-name">${escapeHtml(person.sourceFriend.name)}</span>
                      </div>
                    `
                    : ""
                }
              </div>
            </a>
          `
        )
        .join("")}
    </div>
  `;
}

function renderTabs() {
  const activeTab = state.tabData[state.activePeriod];

  if (!activeTab) {
    elements.tabsCard.classList.add("hidden");
    return;
  }

  elements.tabsCard.classList.remove("hidden");
  elements.tabCaption.textContent = "";
  renderTabsNav();

  elements.tabContent.innerHTML = `
    <div class="tab-panels">
      <section class="panel">
        <h3>Друзья</h3>
        ${renderPeopleList(activeTab.firstLevel)}
      </section>
      <section class="panel">
        <h3>Друзья друзей</h3>
        ${renderPeopleList(activeTab.secondLevel)}
      </section>
    </div>
  `;
}

function renderAll() {
  renderTabsHeader();
  renderTabs();
}

function applyDataset({ user, firstLevel, secondLevel, tabData = null, recommendationGranted = false }) {
  state.user = user;
  state.firstLevel = firstLevel;
  state.secondLevel = secondLevel;
  state.tabData = tabData || {};
  state.recommendationGranted = recommendationGranted;

  if (!tabData) {
    buildTabData();
    writeCache(user, state.tabData);
  }

  renderAll();
  hideNotice();
  setStatus("");
}

function showError(error) {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  state.error = message;
  setStatus("");
  const shouldShowRetry = isLikelyVkEnvironment(state.launchParams);
  showNotice("Не удалось получить информацию.", shouldShowRetry, "Перезагрузить");
}

async function handleVkLoad(appId) {
  if (state.isLoading) {
    return;
  }

  state.isLoading = true;
  setStatus("Загружаем данные");
  hideNotice();

  try {
    const data = await loadVkData(appId);
    applyDataset(data);
  } catch (error) {
    showError(error);
  } finally {
    state.isLoading = false;
  }
}

async function bootstrap() {
  state.launchParams = parseLaunchParams();
  const launchAppId = state.launchParams.vk_app_id || state.launchParams.app_id || "";
  const shouldAutoloadVk = isLikelyVkEnvironment(state.launchParams);

  setStatus(
    ""
  );

  renderTabsNav();

  if (shouldAutoloadVk) {
    handleVkLoad(String(launchAppId || ""));
  } else {
    showNotice("Откройте приложение во ВКонтакте.");
  }
}

bootstrap();
