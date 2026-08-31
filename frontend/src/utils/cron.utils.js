export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEFAULT_FRIENDLY = { frequency: "daily", time: "09:00", daysOfWeek: [1], dayOfMonth: 1, raw: "" };

/*******************************************************************************
 * Function: cronToFriendly
 *
 * Parses a 5-field UTC cron expression into plain-language fields a person
 * can actually edit. Falls back to frequency: "custom" (raw cron, editable
 * as text) for anything it can't confidently represent as daily/weekly/
 * monthly — never silently misrepresents a schedule it doesn't understand.
 ******************************************************************************/
export function cronToFriendly(cron) {
  if (!cron || typeof cron !== "string") return { ...DEFAULT_FRIENDLY, raw: cron || "" };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...DEFAULT_FRIENDLY, frequency: "custom", raw: cron };

  const [min, hour, dom, month, dow] = parts;
  const isSimpleNum = (s, max) => /^\d{1,2}$/.test(s) && Number(s) <= max;
  if (!isSimpleNum(min, 59) || !isSimpleNum(hour, 23) || month !== "*") {
    return { ...DEFAULT_FRIENDLY, frequency: "custom", raw: cron };
  }
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;

  if (dom === "*" && dow === "*") {
    return { frequency: "daily", time, daysOfWeek: [], dayOfMonth: 1, raw: cron };
  }
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow)) {
    return { frequency: "weekly", time, daysOfWeek: dow.split(",").map(Number), dayOfMonth: 1, raw: cron };
  }
  if (dow === "*" && isSimpleNum(dom, 31) && Number(dom) >= 1) {
    return { frequency: "monthly", time, daysOfWeek: [], dayOfMonth: Number(dom), raw: cron };
  }
  return { ...DEFAULT_FRIENDLY, frequency: "custom", raw: cron };
}

/*******************************************************************************
 * Function: friendlyToCron
 *
 * Builds a 5-field UTC cron expression from the friendly fields. "custom"
 * frequency passes the raw text straight through, since that's the escape
 * hatch for anything the friendly picker can't express.
 ******************************************************************************/
export function friendlyToCron({ frequency, time, daysOfWeek, dayOfMonth, raw }) {
  if (frequency === "custom") return (raw || "").trim();
  const [hh = "9", mm = "0"] = (time || "09:00").split(":");
  const h = String(Number(hh));
  const m = String(Number(mm));
  if (frequency === "weekly") {
    const days = daysOfWeek?.length ? [...new Set(daysOfWeek)].sort((a, b) => a - b).join(",") : "1";
    return `${m} ${h} * * ${days}`;
  }
  if (frequency === "monthly") {
    const day = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
    return `${m} ${h} ${day} * *`;
  }
  return `${m} ${h} * * *`; // daily
}

/*******************************************************************************
 * Function: describeFriendlySchedule
 *
 * One-line plain-English summary of a friendly schedule, for the live
 * preview shown under the picker.
 ******************************************************************************/
export function describeFriendlySchedule(friendly) {
  const { frequency, time, daysOfWeek, dayOfMonth, raw } = friendly;
  if (frequency === "daily") return `Runs every day at ${time} UTC`;
  if (frequency === "weekly") {
    if (!daysOfWeek?.length) return "Pick at least one day of the week";
    const names = [...daysOfWeek].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]);
    return `Runs every ${names.join(", ")} at ${time} UTC`;
  }
  if (frequency === "monthly") return `Runs on day ${dayOfMonth} of every month at ${time} UTC`;
  return raw ? `Custom schedule — ${raw}` : "Enter a custom cron expression";
}
