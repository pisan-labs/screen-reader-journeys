/** A file-name-safe version of a journey name. */
export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey";
}
