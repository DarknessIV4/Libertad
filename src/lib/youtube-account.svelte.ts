import { desktop } from './native.ts';

// The YouTube account of the desktop app (see electron/youtube-account.ts). The web build has none.
// Signed in, the embedded player loads from youtube.com, which the login applies to; signed out it
// loads from the privacy-enhanced youtube-nocookie.com, as before.
class YoutubeAccount {
  signedIn = $state(false);
  noHistory = $state(false);
  busy = $state(false);
  error = $state('');
  // The sign-in dialog with its three ways in
  dialog = $state(false);

  private apply(a: { signedIn: boolean; noHistory: boolean }) {
    this.signedIn = a.signedIn;
    this.noHistory = a.noHistory;
  }
  async refresh() {
    if (!desktop) return;
    try { this.apply(await desktop.youtube.account()); } catch { /* keeps what it knew */ }
  }
  // The "Sign in to YouTube" button: the dialog offers the ways in
  signIn() {
    if (!desktop || this.busy) return;
    this.error = '';
    this.dialog = true;
  }
  // Way 3: the app's own sign-in window; resolves when it is closed
  async signInWindow() {
    if (!desktop || this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      this.apply(await desktop.youtube.signIn());
      if (!this.signedIn) this.error = 'Not signed in. The window was closed before the sign-in finished, or Google refused it.';
      else this.dialog = false;
    } catch (e) { this.error = `Could not sign in: ${(e as Error).message}`; }
    this.busy = false;
  }
  // Way 1: the default browser plus the companion extension; resolves when the sign-in arrived or it was cancelled
  async signInBrowser() {
    if (!desktop || this.busy) return;
    this.busy = true;
    this.error = '';
    try {
      const r = await desktop.youtube.browserSignIn();
      this.apply(r);
      if (r.error) this.error = r.error;
      else if (this.signedIn) this.dialog = false;
    } catch (e) { this.error = `Could not sign in: ${(e as Error).message}`; }
    this.busy = false;
  }
  async cancelBrowser() { try { await desktop?.youtube.browserCancel(); } catch { /* it ends by itself */ } }
  // Way 2: pasted cookies. Returns whether it worked; the error says why not.
  async importCookies(text: string): Promise<boolean> {
    if (!desktop || this.busy) return false;
    this.busy = true;
    this.error = '';
    let ok = false;
    try {
      const r = await desktop.youtube.importCookies(text);
      this.apply(r);
      if (r.error) this.error = r.error;
      else if (this.signedIn) { ok = true; this.dialog = false; }
    } catch (e) { this.error = `Could not import: ${(e as Error).message}`; }
    this.busy = false;
    return ok;
  }
  async signOut() {
    if (!desktop || this.busy) return;
    this.busy = true;
    this.error = '';
    try { this.apply(await desktop.youtube.signOut()); }
    catch (e) { this.error = `Could not sign out: ${(e as Error).message}`; }
    this.busy = false;
  }
  async setNoHistory(on: boolean) {
    if (!desktop) return;
    this.noHistory = on;
    try { this.apply(await desktop.youtube.setNoHistory(on)); }
    catch (e) { this.noHistory = !on; this.error = `Could not save: ${(e as Error).message}`; }
  }
}
export const youtubeAccount = new YoutubeAccount();

// Where the embedded player is loaded from
export const youtubeHost = () => youtubeAccount.signedIn ? 'https://www.youtube.com' : 'https://www.youtube-nocookie.com';
