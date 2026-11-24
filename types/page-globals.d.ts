// What this tool puts on a tested page's window (src/recorder.js and the virtual screen reader's
// browser build in src/drivers.js), for `npm run typecheck` (tsc --checkJs).
export {};

declare global {
  interface Window {
    /** The recorder: live-region announcements since the last take(), and stable ids for elements. */
    __srj?: {
      take(): string[];
      idOf(el: Element): number;
      [key: string]: unknown;
    };
    /** Guidepup's Virtual Screen Reader, bundled for the browser. */
    __srjVirtualLib?: {
      virtual: {
        start(options: { container: Element }): Promise<void>;
        next(): Promise<void>;
        stop(): Promise<void>;
        spokenPhraseLog(): Promise<string[]>;
      };
    };
  }
}
