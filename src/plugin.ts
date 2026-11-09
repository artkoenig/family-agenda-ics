import { z } from "zod";
import type { configSchema } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import packageJson from "../package.json" with { type: "json" };
import { calendarAttribute, parseCalendar, sourceRecordOf } from "./calendar";

export type IcsPluginOptions = {
  /** How the plugin reaches the calendar; recorded responses in tests. */
  fetch?: typeof globalThis.fetch;
  /** How long a download may take before the run fails, so that one calendar cannot hold up the rest. */
  timeoutMs?: number;
};

/** The plugin's own version: that of package.json, raised with each release. */
export const version: string = packageJson.version;

/** The sync cursor: the calendar's ETag and the UIDs of the entries it had, to notice those that go. */
const stateSchema = z.object({
  etag: z.string().nullable().catch(null),
  known: z.array(z.unknown()).transform((uids) => uids.filter((uid) => typeof uid === "string")).catch([]),
});
type State = z.output<typeof stateSchema>;

type Download = { body: string; etag: string | null };

type Config = z.infer<typeof configSchema>;

/**
 * Reads a calendar from its secret ICS address and states each entry's Event whole, keyed by UID.
 * Stateless: each poll carries the address and the cursor. An ICS file has no change feed, so each
 * poll whose download changed states every entry, and the core skips those whose Event is
 * unchanged; an entry gone since the last poll is withdrawn.
 */
export function createIcsPlugin(options: IcsPluginOptions = {}): PluginImplementation {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** The calendar, or null if it has not changed since the given ETag. */
  async function download(config: Config, etag: string | null): Promise<Download | null> {
    const url = addressOf(config.secrets.url);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: etag ? { "if-none-match": etag } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PluginError("temporary", `The calendar could not be reached: ${reason}`);
    }
    if (response.status === 304) return null;
    if (!response.ok) {
      const temporary = response.status >= 500 || response.status === 408 || response.status === 429;
      throw new PluginError(temporary ? "temporary" : "definite", `The calendar answered with HTTP ${response.status}.`);
    }
    return { body: await response.text(), etag: response.headers.get("etag") };
  }

  return {
    description: {
      sourceTypeId: "ics",
      kind: "stateless",
      displayName: { en: "ICS calendar", de: "ICS-Kalender" },
      version,
      description: {
        en: "Reads the Events of a calendar from its secret ICS address, such as Google Calendar's private address in iCal format.",
        de: "Liest die Termine eines Kalenders über seine geheime ICS-Adresse, etwa die Privatadresse im iCal-Format von Google Kalender.",
      },
      needsLlm: false,
      configuration: {
        version: 1,
        fields: [
          {
            key: "url",
            label: { en: "Secret ICS address", de: "Geheime ICS-Adresse" },
            secret: true,
            required: true,
            hasChoices: false,
            description: {
              en: 'Such as Google Calendar\'s "Secret address in iCal format". Anyone with it can read the calendar.',
              de: "Etwa die „Privatadresse im iCal-Format“ von Google Kalender. Wer sie kennt, kann den Kalender lesen.",
            },
          },
          {
            key: "name",
            label: { en: "Calendar name", de: "Name des Kalenders" },
            secret: false,
            required: false,
            hasChoices: false,
            description: {
              en: "Optional; by default the name the calendar gives itself.",
              de: "Optional; sonst der Name, den der Kalender sich selbst gibt.",
            },
          },
        ],
      },
      setupSteps: [],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 15 * 60 },
      silentApplies: false,
    },
    async poll(context) {
      const previous = parseState(context.syncCursor);
      const downloaded = await download(context.config, previous.etag);
      if (!downloaded) {
        // A calendar that has not changed keeps the name an Admin gave it, should they change that.
        const configured = configuredName(context.config);
        return {
          sourceRecords: [],
          syncCursor: context.syncCursor,
          ...(configured ? { attributes: { declared: [{ externalId: calendarAttribute, name: configured }], archived: [] } } : {}),
        };
      }
      const calendar = parseCalendar(downloaded.body, context.timeZone);
      const known = calendar.entries.map((entry) => entry.uid);
      const stillThere = new Set(known);
      const state: State = { etag: downloaded.etag, known };
      return {
        sourceRecords: calendar.entries.map(sourceRecordOf),
        syncCursor: JSON.stringify(state),
        withdrawn: previous.known.filter((uid) => !stillThere.has(uid)),
        attributes: {
          declared: [{ externalId: calendarAttribute, name: configuredName(context.config) ?? calendar.name ?? "Calendar" }],
          archived: [],
        },
      };
    },
  };
}

/** The address to download; `webcal:` is how calendar apps are offered the same `https:` one. */
function addressOf(value: string | undefined): string {
  const address = (value ?? "").trim().replace(/^webcal:\/\//i, "https://");
  if (!URL.canParse(address) || !["http:", "https:"].includes(new URL(address).protocol)) {
    throw new PluginError("definite", "The ICS address is no http or https address.");
  }
  return address;
}

/** The name an Admin gave the calendar, if they did. */
function configuredName(config: Config): string | null {
  const name = config.plain.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

function parseState(state: string | null): State {
  const fresh: State = { etag: null, known: [] };
  if (state === null) return fresh;
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return fresh;
  }
  return stateSchema.catch(fresh).parse(parsed);
}
