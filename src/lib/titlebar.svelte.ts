import { desktop } from './native.ts';

// The title bar the page draws itself (Linux and Windows desktop app; macOS and the browser have none of ours).
// height is what the layout leaves free at the top of the window: 0 without the bar and while the window is full screen.
export const TITLEBAR_H = 38;

class TitleBar {
  readonly custom = !!desktop?.titleBar?.custom;
  maximized = $state(false);
  fullscreen = $state(false);

  constructor() {
    const tb = desktop?.titleBar;
    if (!tb?.custom) return;
    tb.state().then(s => this.apply(s)).catch(() => {});
    tb.onState(s => this.apply(s));
  }

  private apply(s: { maximized: boolean; fullscreen: boolean }): void {
    this.maximized = !!s.maximized;
    this.fullscreen = !!s.fullscreen;
  }

  get height(): number { return this.custom && !this.fullscreen ? TITLEBAR_H : 0; }
}

export const titlebar = new TitleBar();
