# My Library

A personal book-tracking website to organize and browse a book collection by genre, author, and title.

## Live Site

- Netlify: https://hussain-books.netlify.app
- GitHub Pages: https://hussain13318.github.io/My-lLbrary/

## Features

- Browse the full book collection in a responsive card grid
- Live search by title or author
- Filter books by genre
- Sort alphabetically by title or author
- View book details (title, author, genre, description, cover) in a modal
- Book covers load from local images when available, with a fallback to the Google Books API

## Tech Stack

- HTML, CSS, and vanilla JavaScript (no frameworks, no build step)
- Book data stored in `books.json`
- Cover images stored locally in the `Images` folder
- Hosted for free on Netlify (connected to this GitHub repository) and GitHub Pages

## Project Structure

├── index.html # Main page
├── style.css # Styling
├── script.js # App logic (search, filter, sort, rendering, cover lookup)
├── books.json # Book data (title, author, genre, description, cover path)
└── Images/ # Local book cover images


## Running Locally

Since this is a static site, you can either:

1. Open `index.html` directly in a browser, or
2. Use a local server (recommended, avoids some browser file:// restrictions):

python -m http.server 8000

   Then visit `http://localhost:8000`

## Updating the Book List

Edit `books.json` to add, remove, or update book entries. Each entry includes:

```json
{
  "title": "Book Title",
  "author": "Author Name",
  "genre": "Genre Name",
  "description": "Short description.",
  "coverImage": "Images/filename.jpg"
}
```

If no local `coverImage` is provided, the site attempts to fetch a cover from the Google Books API automatically.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
