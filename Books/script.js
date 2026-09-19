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
  modalClose: document.querySelector(".modal-close"),
};

const COVER_CACHE_STORAGE_KEY = "my-library-google-covers-v1";
const MAX_CONCURRENT_COVER_REQUESTS = 3;
const COVER_REQUEST_GAP_MS = 220;
let allBooks = [];
let filteredBooks = [];
const coverCache = new Map(loadPersistedCoverEntries());
const activeFetches = new Map();
const coverRequestQueue = [];
let activeCoverRequests = 0;
let nextAllowedRequestAt = 0;

init();

async function init() {
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

  } catch {
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
  elements.genreFilter.replaceChildren(new Option("All genres", "all"));

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
  elements.bookGrid.replaceChildren();
  elements.emptyState.hidden = books.length !== 0;
  elements.visibleBooks.textContent = String(books.length);
  elements.footerCount.textContent = String(allBooks.length);

  books.forEach((book, index) => {
    elements.bookGrid.appendChild(createBookCard(book, index));
  });
}

function createBookCard(book, index) {
  const card = elements.bookCardTemplate.content.firstElementChild.cloneNode(true);
  const cover = card.querySelector(".book-cover");
  const genrePill = card.querySelector(".genre-pill");

  genrePill.textContent = book.genre;
  card.querySelector(".book-title").textContent = book.title;
  card.querySelector(".book-author").textContent = book.author;
  cover.alt = `Cover of ${book.title}`;
  cover.loading = index < 6 ? "eager" : "lazy";
  cover.decoding = "async";
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

function setImageSource(imageElement, source, book) {
  imageElement.alt = `Cover of ${book.title}`;
  imageElement.src = source;
}

async function loadBookCover(book, imageElement) {
  if (book.coverImage) {
    setImageSource(imageElement, book.coverImage, book);
    return;
  }

  const cacheKey = `${book.title}::${book.author}`.toLowerCase();
  if (coverCache.has(cacheKey)) {
    setImageSource(imageElement, coverCache.get(cacheKey), book);
    return;
  }

  if (activeFetches.has(cacheKey)) {
    setImageSource(imageElement, await activeFetches.get(cacheKey), book);
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
    setImageSource(imageElement, await fetchPromise, book);
  } catch {
    setImageSource(imageElement, createPlaceholderCover(book.title), book);
  }
}

function setCoverFallback(imageElement, book) {
  imageElement.onerror = () => {
    imageElement.onerror = null;
    setImageSource(imageElement, createPlaceholderCover(book.title), book);
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
      if (!thumbnail) return null;
      const coverUrl = new URL(thumbnail);
      coverUrl.protocol = "https:";
      return coverUrl.toString();
    } catch {
      if (attempt === maxAttempts) return null;
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

let lastFocusedElement;

function openModal(book) {
  lastFocusedElement = document.activeElement;
  elements.modalTitle.textContent = book.title;
  elements.modalAuthor.textContent = `By ${book.author}`;
  elements.modalGenre.textContent = book.genre;
  elements.modalDescription.textContent = book.description;
  elements.modalCover.alt = `Cover of ${book.title}`;
  elements.modalCover.loading = "eager";
  elements.modalCover.decoding = "async";
  setCoverFallback(elements.modalCover, book);
  loadBookCover(book, elements.modalCover);
  elements.modal.classList.add("is-open");
  elements.modal.setAttribute("aria-hidden", "false");
  elements.modalClose.focus();
}

function handleModalClose(event) {
  if (event.target.matches("[data-close-modal]")) closeModal();
}

function closeModal() {
  elements.modal.classList.remove("is-open");
  elements.modal.setAttribute("aria-hidden", "true");
  lastFocusedElement?.focus();
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
  elements.genreCounts.replaceChildren();
  for (const genre of Object.keys(counts).sort((a, b) => a.localeCompare(b))) {
    const chip = document.createElement("div");
    chip.className = "genre-chip";
    const name = document.createElement("span");
    name.textContent = genre;
    const count = document.createElement("strong");
    count.textContent = String(counts[genre]);
    chip.append(name, count);
    elements.genreCounts.appendChild(chip);
  }
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
