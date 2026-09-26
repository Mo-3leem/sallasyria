"use client";

/** Builder selection model shared by the page and both panels. */
export type Selection =
  | "appearance"
  | "header"
  | "footer"
  | `section:${number}`
  | null;
