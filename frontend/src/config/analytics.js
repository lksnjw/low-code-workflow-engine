import { appConfig } from "./app";

/*******************************************************************************
 * Function: trackEvent
 *
 * Performs the track Event operation on event for the analytics module.
 ******************************************************************************/
export function trackEvent(eventName, payload = {}) {
  if (!appConfig.analyticsEnabled) {
    return;
  }

  console.info("[analytics]", eventName, payload);
}
