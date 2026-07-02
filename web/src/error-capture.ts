import { toast } from "./toast";

const NETWORK_FAILURE_SIGNATURES = ["Failed to fetch", "NetworkError", "ERR_CONNECTION", "ERR_NETWORK"];

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function isNetworkFailure(message: string): boolean {
  return NETWORK_FAILURE_SIGNATURES.some((sig) => message.includes(sig));
}

/**
 * Called once at app startup (web/src/main.tsx), before render. Gives every existing and
 * future console.error call a toast for free, plus a safety net for anything that escapes
 * try/catch entirely (uncaught exceptions, unhandled promise rejections).
 */
export function installGlobalErrorCapture(): void {
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const message = args.map(stringifyArg).join(" ");
    if (isNetworkFailure(message)) {
      toast.critical(message, "Backend unreachable");
    } else {
      toast.error(message);
    }
  };

  window.addEventListener("error", (event) => {
    toast.critical(event.message, "Uncaught error");
  });

  window.addEventListener("unhandledrejection", (event) => {
    const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
    toast.critical(message, "Unhandled rejection");
  });
}
