// Half-typed messages survive the main view being taken down while the window is hidden (see background.ts).
// Each message box carries data-draft="<chat>"; going hidden copies what is in them, the box takes its text back
// when it is drawn again. Nothing is kept anywhere else, and a draft is used once.
const kept = new Map<string, string>();

export const drafts = {
  capture(): void {
    for (const el of document.querySelectorAll<HTMLElement>('[data-draft]')) {
      const key = el.dataset.draft!;
      if (el.textContent?.trim() || el.querySelector('img')) kept.set(key, el.innerHTML);
    }
  },
  take(key: string): string | null {
    const html = kept.get(key) ?? null;
    kept.delete(key);
    return html;
  }
};
