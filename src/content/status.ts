import type { FailureReason } from "../shared/messages";

/** What the popup asks the content script for. */
export interface PageStatus {
  siteId: string;
  swapped: boolean;
  source?: "cache" | "api";
  reason?: FailureReason;
  original: string;
}
