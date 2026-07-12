import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createStoryDb } from "./helpers.js";
import { createBook, getBook, setBookHidden, setBookBroken, getBookByType } from "../../src/db/book-store.js";
import type { BookType } from "../../src/db/book-store.js";

let db: Database.Database;

beforeEach(() => {
  db = createStoryDb();
});

describe("createBook", () => {
  it("creates a book with default values", () => {
    const book = createBook(db, { bookType: "logbook" });
    expect(book.id).toBeTruthy();
    expect(book.bookType).toBe("logbook");
    expect(book.hidden).toBe(false);
    expect(book.broken).toBe(false);
    expect(book.parentBookId).toBeNull();
  });

  it("creates a book with a parent", () => {
    const parent = createBook(db, { bookType: "game" });
    const child = createBook(db, { bookType: "logbook", parentBookId: parent.id });
    expect(child.parentBookId).toBe(parent.id);
  });

  it("supports all valid book types", () => {
    const types: BookType[] = ["user", "game", "worldbook", "sourcebook", "logbook"];
    for (const bookType of types) {
      const book = createBook(db, { bookType });
      expect(book.bookType).toBe(bookType);
    }
  });
});

describe("getBook", () => {
  it("returns the created book", () => {
    const created = createBook(db, { bookType: "logbook" });
    const found = getBook(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.bookType).toBe("logbook");
  });

  it("returns null for unknown id", () => {
    expect(getBook(db, "nonexistent")).toBeNull();
  });
});

describe("setBookHidden", () => {
  it("hides and unhides a book", () => {
    const book = createBook(db, { bookType: "logbook" });
    setBookHidden(db, book.id, true);
    expect(getBook(db, book.id)!.hidden).toBe(true);
    setBookHidden(db, book.id, false);
    expect(getBook(db, book.id)!.hidden).toBe(false);
  });
});

describe("setBookBroken", () => {
  it("marks and unmarks a book as broken", () => {
    const book = createBook(db, { bookType: "logbook" });
    setBookBroken(db, book.id, true);
    expect(getBook(db, book.id)!.broken).toBe(true);
    setBookBroken(db, book.id, false);
    expect(getBook(db, book.id)!.broken).toBe(false);
  });
});

describe("getBookByType", () => {
  it("returns the first matching book by type", () => {
    createBook(db, { bookType: "logbook" });
    const found = getBookByType(db, "logbook");
    expect(found).not.toBeNull();
    expect(found!.bookType).toBe("logbook");
  });

  it("returns null when no book of type exists", () => {
    expect(getBookByType(db, "sourcebook")).toBeNull();
  });
});