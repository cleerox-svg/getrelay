// Per-device Giphy "random ID" for the Action Register / analytics flow.
//
// Giphy asks that pingbacks carry a random_id that is stable for a user
// session but contains no personally identifiable information, so it can
// tune responses without tracking real identities. We mint one per device,
// persist it in localStorage, and reuse it for the life of the install.
const KEY = 'relay.giphyRandomId';

export function getGiphyRandomId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts. Analytics
    // is best-effort, so fall back to an ephemeral id for this page load.
    return crypto.randomUUID();
  }
}
