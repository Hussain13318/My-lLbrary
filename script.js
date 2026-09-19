const elements = {
  searchInput: document.getElementById("searchInput"),
  genreFilter: document.getElementById("genreFilter"),
  sortSelect: document.getElementById("sortSelect"),
  bookGrid: document.getElementById("bookGrid"),
  emptyState: document.getElementById("emptyState"),
  totalBooks: document.getElementById("totalBooks"),
  totalGenres: document.getElementById("totalGenres"),
  visibleBooks: document.getElementById("visibleBooks"),
  footerCount: document.getElementById("footerCount"),
  genreCounts: document.getElementById("genreCounts"),
  bookCardTemplate: document.getElementById("bookCardTemplate"),
  modal: document.getElementById("bookModal"),
  modalTitle: document.getElementById("modalTitle"),
  modalAuthor: document.getElementById("modalAuthor"),
  modalGenre: document.getElementById("modalGenre"),
  modalDescription: document.getElementById("modalDescription"),
  modalCover: document.getElementById("modalCover"),
};

const COVER_CACHE_STORAGE_KEY = "my-library-google-covers-v1";
const MAX_CONCURRENT_COVER_REQUESTS = 3;
const COVER_REQUEST_GAP_MS = 220;
const FALLBACK_COVER = createPlaceholderCover("No Cover");

let allBooks = [];
let filteredBooks = [];
let debugLogList;
const coverCache = new Map(loadPersistedCoverEntries());
const activeFetches = new Map();
const coverRequestQueue = [];
let activeCoverRequests = 0;
let nextAllowedRequestAt = 0;

init();

async function init() {
  setupDebugPanel();

  try {
    const response = await fetch("books.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`books.json returned HTTP ${response.status}`);
    }

    const books = await response.json();
    allBooks = books.map((book, index) => ({
      id: book.id ?? `${book.title}-${index}`,
      title: book.title || "Untitled",
      author: book.author || "Unknown Author",
      genre: book.genre || "Uncategorized",
      description: book.description || "No description provided.",
      coverImage: book.coverImage || "",
    }));

    console.info(`Loaded ${allBooks.length} books from books.json.`);
    logDebug("info", `Loaded ${allBooks.length} books from books.json.`);
  } catch (error) {
    console.error("Unable to load books.json.", error);
    logDebug("error", `Unable to load books.json: ${error.message || error}`);
    allBooks = [];
  }

  populateGenreFilter();
  updateCounters(allBooks);
  attachListeners();
  applyFilters();
}

function attachListeners() {
  elements.searchInput.addEventListener("input", applyFilters);
  elements.genreFilter.addEventListener("change", applyFilters);
  elements.sortSelect.addEventListener("change", applyFilters);
  elements.modal.addEventListener("click", handleModalClose);
  document.addEventListener("keydown", handleKeyboardShortcuts);
}

function populateGenreFilter() {
  const genres = [...new Set(allBooks.map((book) => book.genre))].sort((a, b) => a.localeCompare(b));
  elements.genreFilter.innerHTML = '<option value="all">All genres</option>';

  for (const genre of genres) {
    const option = document.createElement("option");
    option.value = genre;
    option.textContent = genre;
    elements.genreFilter.appendChild(option);
  }

  elements.totalGenres.textContent = String(genres.length);
}

function applyFilters() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const selectedGenre = elements.genreFilter.value;
  const sortMode = elements.sortSelect.value;

  filteredBooks = allBooks.filter((book) => {
    const matchesQuery = !query || book.title.toLowerCase().includes(query) || book.author.toLowerCase().includes(query);
    const matchesGenre = selectedGenre === "all" || book.genre === selectedGenre;
    return matchesQuery && matchesGenre;
  });

  filteredBooks.sort((left, right) => {
    if (sortMode === "author-asc") {
      return left.author.localeCompare(right.author) || left.title.localeCompare(right.title);
    }
    return left.title.localeCompare(right.title) || left.author.localeCompare(right.author);
  });

  renderBooks(filteredBooks);
  updateCounters(filteredBooks);
}

function renderBooks(books) {
  elements.bookGrid.innerHTML = "";
  elements.emptyState.hidden = books.length !== 0;
  elements.visibleBooks.textContent = String(books.length);
  elements.footerCount.textContent = String(allBooks.length);

  for (const book of books) {
    elements.bookGrid.appendChild(createBookCard(book));
  }
}

function createBookCard(book) {
  const card = elements.bookCardTemplate.content.firstElementChild.cloneNode(true);
  const cover = card.querySelector(".book-cover");
  const genrePill = card.querySelector(".genre-pill");

  genrePill.textContent = book.genre;
  card.querySelector(".book-title").textContent = book.title;
  card.querySelector(".book-author").textContent = book.author;
  cover.alt = `${book.title} cover`;
  setCoverFallback(cover, book);
  loadBookCover(book, cover);

  card.addEventListener("click", () => openModal(book));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openModal(book);
    }
  });

  return card;
}

async function loadBookCover(book, imageElement) {
  if (book.coverImage) {
    console.info(`Using local cover for ${book.title}: ${book.coverImage}`);
    imageElement.src = book.coverImage;
    return;
  }

  const cacheKey = `${book.title}::${book.author}`.toLowerCase();
  if (coverCache.has(cacheKey)) {
    imageElement.src = coverCache.get(cacheKey);
    return;
  }

  if (activeFetches.has(cacheKey)) {
    imageElement.src = await activeFetches.get(cacheKey);
    return;
  }

  const fetchPromise = enqueueCoverRequest(() => fetchGoogleBookCoverWithRetry(book))
    .then((url) => {
      const coverUrl = url || createPlaceholderCover(book.title);
      coverCache.set(cacheKey, coverUrl);
      if (url) {
        persistCoverCacheEntry(cacheKey, coverUrl);
      }
      return coverUrl;
    })
    .finally(() => activeFetches.delete(cacheKey));

  activeFetches.set(cacheKey, fetchPromise);

  try {
    imageElement.src = await fetchPromise;
  } catch (error) {
    console.warn(`Cover request failed for ${book.title}.`, error);
    imageElement.src = createPlaceholderCover(book.title);
  }
}

function setCoverFallback(imageElement, book) {
  imageElement.onerror = () => {
    if (imageElement.src.endsWith("/" + book.coverImage) && book.coverImage) {
      console.warn(`Local cover failed for ${book.title}.`);
    }
    imageElement.src = createPlaceholderCover(book.title);
  };
}

function enqueueCoverRequest(task) {
  return new Promise((resolve, reject) => {
    coverRequestQueue.push({ task, resolve, reject });
    pumpCoverQueue();
  });
}

function pumpCoverQueue() {
  if (!coverRequestQueue.length || activeCoverRequests >= MAX_CONCURRENT_COVER_REQUESTS) {
    return;
  }

  const delayMs = Math.max(0, nextAllowedRequestAt - Date.now());
  if (delayMs > 0) {
    setTimeout(pumpCoverQueue, delayMs);
    return;
  }

  const queued = coverRequestQueue.shift();
  activeCoverRequests += 1;
  nextAllowedRequestAt = Date.now() + COVER_REQUEST_GAP_MS;
  queued.task().then(queued.resolve, queued.reject).finally(() => {
    activeCoverRequests -= 1;
    pumpCoverQueue();
  });
}

async function fetchGoogleBookCoverWithRetry(book, maxAttempts = 3) {
  const query = `intitle:${String(book.title).replaceAll("*", " ")} inauthor:${book.author}`;
  const endpoint = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          await wait(attempt * 900);
          continue;
        }
        return null;
      }

      const data = await response.json();
      const thumbnail = extractThumbnail(data);
      return thumbnail ? thumbnail.replace("http:", "https:") : null;
    } catch (error) {
      if (attempt === maxAttempts) {
        console.warn(`Google Books lookup failed for ${book.title}.`, error);
        return null;
      }
      await wait(attempt * 900);
    }
  }

  return null;
}

function extractThumbnail(data) {
  for (const item of data?.items || []) {
    const links = item?.volumeInfo?.imageLinks;
    if (links?.thumbnail) return links.thumbnail;
    if (links?.smallThumbnail) return links.smallThumbnail;
  }
  return null;
}

function openModal(book) {
  elements.modalTitle.textContent = book.title;
  elements.modalAuthor.textContent = `By ${book.author}`;
  elements.modalGenre.textContent = book.genre;
  elements.modalDescription.textContent = book.description;
  elements.modalCover.alt = `${book.title} cover`;
  setCoverFallback(elements.modalCover, book);
  loadBookCover(book, elements.modalCover);
  elements.modal.classList.add("is-open");
  elements.modal.setAttribute("aria-hidden", "false");
}

function handleModalClose(event) {
  if (event.target.matches("[data-close-modal]")) closeModal();
}

function closeModal() {
  elements.modal.classList.remove("is-open");
  elements.modal.setAttribute("aria-hidden", "true");
}

function handleKeyboardShortcuts(event) {
  if (event.key === "Escape" && elements.modal.classList.contains("is-open")) closeModal();
}

function updateCounters(books) {
  elements.totalBooks.textContent = String(allBooks.length);
  elements.footerCount.textContent = String(allBooks.length);
  elements.visibleBooks.textContent = String(books.length);

  const counts = allBooks.reduce((result, book) => {
    result[book.genre] = (result[book.genre] || 0) + 1;
    return result;
  }, {});
  renderGenreCounts(counts);
}

function renderGenreCounts(counts) {
  elements.genreCounts.innerHTML = "";
  for (const genre of Object.keys(counts).sort((a, b) => a.localeCompare(b))) {
    const chip = document.createElement("div");
    chip.className = "genre-chip";
    chip.innerHTML = `<span>${genre}</span><strong>${counts[genre]}</strong>`;
    elements.genreCounts.appendChild(chip);
  }
}

function setupDebugPanel() {
  const panel = document.createElement("section");
  panel.id = "debugPanel";
  panel.style.cssText = "display:none";
  debugLogList = document.createElement("div");
  panel.appendChild(debugLogList);
  document.querySelector(".page-shell").after(panel);
}

function logDebug(level, message) {
  if (!debugLogList) return;
  const entry = document.createElement("div");
  entry.textContent = `[${level.toUpperCase()}] ${message}`;
  debugLogList.appendChild(entry);
}

function loadPersistedCoverEntries() {
  try {
    const value = JSON.parse(localStorage.getItem(COVER_CACHE_STORAGE_KEY) || "{}");
    return Object.entries(value);
  } catch {
    return [];
  }
}

function persistCoverCacheEntry(key, value) {
  try {
    const current = Object.fromEntries(loadPersistedCoverEntries());
    current[key] = value;
    localStorage.setItem(COVER_CACHE_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPlaceholderCover(text) {
  const label = String(text).slice(0, 22);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" rx="36" fill="#eaf1f7"/><text x="300" y="370" text-anchor="middle" fill="#163b63" font-family="Arial" font-size="42" font-weight="700">${escapeHtml(label)}</text><text x="300" y="430" text-anchor="middle" fill="#667085" font-family="Arial" font-size="24">Cover unavailable</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
