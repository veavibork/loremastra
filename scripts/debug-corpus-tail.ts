#!/usr/bin/env npx tsx
import { getStoryDb } from "../src/db/story-db.js";
import { getBookByType } from "../src/db/book-store.js";
import { listChronologicalPages } from "../src/db/page-store.js";
import { getText } from "../src/db/text-store.js";
import { findHeadPageId } from "../src/db/page-store.js";
import { resolveChainPostNumber, countChainPosts, buildChainPostIndex } from "../src/services/post-index.js";

const storyId = process.argv[2] ?? "019f25e0-219c-7189-b481-9f389a9a3c39";
const db = getStoryDb(storyId);
const logbook = getBookByType(db, "logbook")!;
const pages = listChronologicalPages(db, logbook.id);
const headId = findHeadPageId(db, logbook.id);
const last = pages[pages.length - 1];
const head = pages.find((p) => p.id === headId);
const lastText = last?.selectedTextId ? getText(db, last.selectedTextId) : null;

console.log("pages", pages.length, "chain posts", countChainPosts(db, logbook.id));
console.log("last page", last?.id.slice(0, 8), "has content", !!lastText?.genPackage?.trim());
console.log("head page", head?.id.slice(0, 8), "same as last", head?.id === last?.id);
console.log("resolve last page post#", last ? resolveChainPostNumber(db, logbook.id, last.id) : null);
console.log("chain tail", buildChainPostIndex(db, logbook.id).slice(-3).map((e) => e.postNumber));
