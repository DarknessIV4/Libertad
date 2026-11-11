// What we know of the embedded YouTube player, and the bookkeeping that tells the user's own
// clicks apart from the player merely reporting a command of ours taking effect.
//
// Kept free of the DOM so it can be tested on its own. Time is in seconds like YouTube's own API,
// except where a name says Ms.

export const YT_UNSTARTED = -1;
export const YT_ENDED = 0;
export const YT_PLAYING = 1;
export const YT_PAUSED = 2;
export const YT_BUFFERING = 3;
export const YT_CUED = 5;

// A report that matches a command of ours within this long is that command taking effect
export const ECHO_MS = 2500;
// The player is slow to answer a command; the first moments after one carry news of what came
// before it, which is neither the user nor our command
export const STALE_MS = 400;
// A command the player has not confirmed within this long is taken as lost: it may be sent again
export const COMMAND_GRACE_MS = 1200;
// After a seek of ours the player keeps reporting where it was; wait this long for it to arrive
export const SEEK_ECHO_MS = 3000;
export const SEEK_ECHO_TOLERANCE_MAX_S = 2;
export const SEEK_ECHO_TOLERANCE_MIN_S = 0.3;
// A jump of the position bigger than this that we did not cause is the user seeking. A paused
// player holds still, so there a much smaller one is
export const SEEK_JUMP_S = 1.5;
export const SEEK_JUMP_PAUSED_S = 0.5;
// A paused player that starts buffering by itself is the user pressing play (or seeking): until
// this long after, it is not pulled back to the shared state, which still says "paused"
export const USER_BUSY_MS = 1500;

export interface PlayerReport { currentTime?: number; playerState?: number }

// What the user did in the player, as far as a report shows
export interface UserActions {
  playing?: boolean;  // pressed play (true) or pause (false)
  seekMs?: number;    // dragged the position here
}

export class YtTracker {
  pos = 0;                      // last position (seconds) ...
  posAt = 0;                    // ... and when it was true
  reported = YT_UNSTARTED;      // the last state the player itself reported
  // Without any answer from the embed we have only our own commands to go by
  blind = false;
  // The playback speed (the person's own choice): the position moves this many seconds per second
  rate = 1;

  private havePos = false;
  // The last play/pause we commanded, until the player confirms it
  private intent: { playing: boolean; at: number } | null = null;
  // Commands whose effect we still expect to hear about, oldest first
  private echoes: { playing: boolean; until: number }[] = [];
  private seekEcho: { until: number; tol: number } | null = null;
  private userBusyUntil = 0;

  // The embed was (re)loaded: it knows nothing yet. The position we believe in stays.
  reset() {
    this.reported = YT_UNSTARTED;
    this.blind = false;
    this.havePos = false;
    this.intent = null;
    this.echoes = [];
    this.seekEcho = null;
    this.userBusyUntil = 0;
  }

  // A player is being set up to begin here
  begin(startS: number, now = Date.now()) {
    this.reset();
    this.pos = startS;
    this.posAt = now;
  }

  // A new playback speed: the position so far is kept
  setRate(rate: number, now = Date.now()) {
    this.rebase(now);
    this.rate = rate;
  }

  // The embed will start by itself (autoplay): its "playing" report is not the user pressing play
  expectAutoplay(now = Date.now()) {
    this.echoes.push({ playing: true, until: now + ECHO_MS * 1.5 });
  }

  // The state to go by: what we last commanded while that is still fresh, else what the player says
  effectiveState(now = Date.now()): number {
    if (this.intent && (this.blind || now - this.intent.at < COMMAND_GRACE_MS)) {
      return this.intent.playing ? YT_PLAYING : YT_PAUSED;
    }
    return this.reported;
  }

  position(now = Date.now()): number {
    return this.effectiveState(now) === YT_PLAYING ? this.pos + ((now - this.posAt) / 1000) * this.rate : this.pos;
  }

  private rebase(now: number) {
    this.pos = this.position(now);
    this.posAt = now;
  }

  private prune(now: number) {
    this.echoes = this.echoes.filter(e => e.until > now);
    if (this.seekEcho && this.seekEcho.until <= now) this.seekEcho = null;
  }

  // Commands: each returns whether the player has to be told. Asking for what is already so (or
  // already on its way) sends nothing, so nothing is left waiting for an echo that never comes.
  play(now = Date.now()): boolean {
    const st = this.effectiveState(now);
    if (st === YT_PLAYING || st === YT_BUFFERING) return false;
    this.prune(now);
    this.rebase(now);
    this.intent = { playing: true, at: now };
    this.echoes.push({ playing: true, until: now + ECHO_MS });
    return true;
  }

  pause(now = Date.now()): boolean {
    const st = this.effectiveState(now);
    if (st !== YT_PLAYING && st !== YT_BUFFERING) return false;
    // It is buffering because the user just pressed play: let that play out
    if (st === YT_BUFFERING && now < this.userBusyUntil) return false;
    this.prune(now);
    this.rebase(now);
    this.intent = { playing: false, at: now };
    this.echoes.push({ playing: false, until: now + ECHO_MS });
    return true;
  }

  seek(ms: number, now = Date.now()) {
    // "Arrived" means closer to the target than the place it came from: half the distance, within bounds
    const dist = Math.abs(ms / 1000 - this.position(now));
    const tol = Math.min(SEEK_ECHO_TOLERANCE_MAX_S, Math.max(SEEK_ECHO_TOLERANCE_MIN_S, dist / 2));
    this.pos = ms / 1000;
    this.posAt = now;
    this.havePos = true;
    this.seekEcho = { until: now + SEEK_ECHO_MS, tol };
  }

  // The player reported its position and/or state. Returns what the user did, if anything
  // (detectUser false: only keep track).
  sample(info: PlayerReport, detectUser: boolean, now = Date.now()): UserActions {
    this.prune(now);
    const out: UserActions = {};
    const st = typeof info.playerState === 'number' ? info.playerState : null;
    const t = typeof info.currentTime === 'number' ? info.currentTime : null;

    // Position first, so that a state change below is stamped with where the player really is.
    // An unstarted player reports 0, which says nothing about where it will begin.
    if (t !== null && (st ?? this.reported) !== YT_UNSTARTED) {
      let take = true;
      if (this.seekEcho) {
        // Still reporting where it was before our seek, until it gets to where we sent it
        if (Math.abs(t - this.position(now)) <= this.seekEcho.tol) this.seekEcho = null;
        else take = false;
      }
      if (take) {
        const jump = this.effectiveState(now) === YT_PLAYING ? SEEK_JUMP_S : SEEK_JUMP_PAUSED_S;
        if (detectUser && this.havePos && Math.abs(t - this.position(now)) > jump) {
          out.seekMs = Math.round(t * 1000);
        }
        this.pos = t;
        this.posAt = now;
        this.havePos = true;
      }
    }

    if (st !== null && st !== this.reported) {
      this.rebase(now); // the position stays continuous across the change
      const prev = this.reported;
      this.reported = st;
      if (detectUser && st === YT_BUFFERING && (prev === YT_PAUSED || prev === YT_CUED) && !this.intent && !this.seekEcho) {
        this.userBusyUntil = now + USER_BUSY_MS;
      }
      const i = this.intent;
      // A report in the direction of our command confirms it
      if (i && (i.playing ? st === YT_PLAYING || st === YT_BUFFERING : st === YT_PAUSED)) this.intent = null;

      if (st === YT_PLAYING || st === YT_PAUSED) {
        const playing = st === YT_PLAYING;
        const at = this.echoes.findIndex(e => e.playing === playing);
        if (at >= 0) {
          // Our command taking effect; anything older was overtaken by it
          this.echoes.splice(0, at + 1);
        } else if (this.intent && now - this.intent.at < STALE_MS) {
          // Still unconfirmed and this close behind our command: late news of what the player was
          // doing before the command reached it, not a person reacting
        } else {
          this.echoes = [];
          if (detectUser) out.playing = playing;
        }
      }
    }
    return out;
  }
}
