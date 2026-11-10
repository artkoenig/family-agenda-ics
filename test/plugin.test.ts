import { readFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginHandler, servePlugin } from "@family-agenda/plugin-kit/server";
import { contractProblems, pluginClient, type Answer } from "@family-agenda/plugin-kit/testing";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
import type { IngestResult } from "@family-agenda/plugin-contract";
import { createIcsPlugin, type IcsPluginOptions } from "../src/plugin";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const url = "https://calendar.example.org/ical/secret-token/basic.ics";
const config = { plain: {}, secrets: { url } };
const now = new Date("2026-09-14T07:00:00Z");

/** A calendar server that answers every request with the next of the given responses. */
function server(...responses: (Response | Error)[]) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: input instanceof Request ? input.url : input.toString(), headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, requests };
}

const calendar = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/calendar", ...headers } });

type Context = { config?: { plain: Record<string, unknown>; secrets: Record<string, string> }; syncCursor?: string | null };

/** A plugin as the core sees it, over the kit's validating handler: polls answer status and body. */
function icsPlugin(options: IcsPluginOptions) {
  const call = pluginClient(createPluginHandler(createIcsPlugin(options)));
  const answer = (context: Context = {}): Promise<Answer> =>
    call("poll", { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin", ...context });
  const poll = async (context: Context = {}): Promise<IngestResult> => {
    const { status, body } = await answer(context);
    if (status !== 200) throw new Error(`poll answered ${status}: ${JSON.stringify(body)}`);
    return body as IngestResult;
  };
  const attributes = async (context: Context = {}) => {
    const { status, body } = await call("sourceAttributes", { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin", ...context });
    if (status !== 200) throw new Error(`sourceAttributes answered ${status}: ${JSON.stringify(body)}`);
    return body as NonNullable<IngestResult["attributes"]>;
  };
  return { answer, poll, attributes };
}

/** Each Source Record as its UID and the Event it states. */
const statements = (records: IngestResult["sourceRecords"]) =>
  records.flatMap((record) =>
    record.content.kind === "stated" && record.content.stated.kind === "event" ? [{ key: record.externalId, ...record.content.stated }] : [],
  );

const timed = (start: string, end: string) => ({ allDay: false as const, start, end });

const twice = () => createPluginHandler(createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v1.ics"))).fetch }));

describePluginContract(twice, { config, now, languages: ["de"] });

describe("the ICS plugin", () => {
  it("states each calendar entry's Event whole, keyed by UID, cancelled only by its status", async () => {
    const { poll } = icsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const { sourceRecords, withdrawn } = await poll();

    expect(statements(sourceRecords)).toEqual([
      {
        key: "piano-0915@google.com",
        kind: "event",
        title: "Piano lesson",
        span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"),
        place: "Music school, room 3",
        cancelled: false,
      },
      {
        key: "trip@google.com",
        kind: "event",
        title: "Class trip",
        span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" },
        place: null,
        cancelled: false,
      },
      {
        key: "match@google.com",
        kind: "event",
        title: "Football match",
        span: timed("2026-09-16T15:00:00.000Z", "2026-09-16T16:30:00.000Z"),
        place: "Sports ground",
        cancelled: false,
      },
      {
        key: "fair@google.com",
        kind: "event",
        title: "School fair",
        span: timed("2026-09-19T08:00:00.000Z", "2026-09-19T10:00:00.000Z"),
        place: null,
        cancelled: true,
      },
      {
        key: "dentist@google.com",
        kind: "event",
        title: "Dentist",
        span: timed("2026-09-21T07:00:00.000Z", "2026-09-21T08:00:00.000Z"),
        place: null,
        cancelled: false,
      },
    ]);
    expect(sourceRecords.every((record) => record.occurredAt === undefined)).toBe(true);
    expect(withdrawn).toEqual([]);
  });

  it("declares the calendar under its own name, names it on its Source Records, and links to an entry's own address", async () => {
    const { poll } = icsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch });

    const { sourceRecords, attributes } = await poll();

    expect(attributes).toEqual({ declared: [{ externalId: "calendar", name: "Mia's clubs" }], archived: [] });
    expect(sourceRecords[0]).toMatchObject({
      externalId: "piano-0915@google.com",
      attributes: ["calendar"],
      link: "https://calendar.example.org/event/piano-0915",
    });
    expect(sourceRecords[1]?.link).toBeUndefined();
  });

  it("drops an entry's link that is no web address it can parse", async () => {
    const entries = ["UID:mail\r\nURL:mailto:club@example.org", "UID:broken\r\nURL:https://exa mple.org/x"];
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${entries
      .map((entry) => `BEGIN:VEVENT\r\n${entry}\r\nDTSTART;VALUE=DATE:20260918\r\nSUMMARY:Entry\r\nEND:VEVENT\r\n`)
      .join("")}END:VCALENDAR\r\n`;
    const { poll } = icsPlugin({ fetch: server(calendar(body)).fetch });

    const { sourceRecords } = await poll();

    expect(sourceRecords.map((record) => [record.externalId, record.link])).toEqual([
      ["mail", undefined],
      ["broken", undefined],
    ]);
  });

  it("fails definitely on an address that is no web address", async () => {
    const { answer } = icsPlugin({ fetch: server().fetch });

    expect(await answer({ config: { plain: {}, secrets: { url: "file:///etc/passwd" } } })).toMatchObject({ status: 422, body: { kind: "definite" } });
  });

  it("states every entry again once the calendar changed, and withdraws those gone from it", async () => {
    const { poll } = icsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v2.ics"))).fetch });
    const first = await poll();

    const { sourceRecords, withdrawn } = await poll({ syncCursor: first.syncCursor });

    expect(statements(sourceRecords)).toEqual([
      {
        key: "piano-0915@google.com",
        kind: "event",
        title: "Piano lesson",
        span: timed("2026-09-15T15:00:00.000Z", "2026-09-15T16:00:00.000Z"),
        place: "Music school, room 3",
        cancelled: false,
      },
      {
        key: "trip@google.com",
        kind: "event",
        title: "Class trip",
        span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" },
        place: null,
        cancelled: true,
      },
      {
        key: "match@google.com",
        kind: "event",
        title: "Football final",
        span: timed("2026-09-16T15:00:00.000Z", "2026-09-16T16:30:00.000Z"),
        place: "Stadium",
        cancelled: false,
      },
      {
        key: "fair@google.com",
        kind: "event",
        title: "School fair",
        span: timed("2026-09-19T08:00:00.000Z", "2026-09-19T10:00:00.000Z"),
        place: null,
        cancelled: true,
      },
      {
        key: "parents-evening@google.com",
        kind: "event",
        title: "Parents' evening",
        span: timed("2026-09-22T16:00:00.000Z", "2026-09-22T17:30:00.000Z"),
        place: "Assembly hall",
        cancelled: false,
      },
    ]);
    // Deleted from the calendar: withdrawn, not cancelled.
    expect(withdrawn).toEqual(["dentist@google.com"]);
  });

  it("states an entry again that comes back after it was gone", async () => {
    const { poll } = icsPlugin({
      fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v2.ics")), calendar(fixture("family-v1.ics"))).fetch,
    });
    const first = await poll();
    const gone = await poll({ syncCursor: first.syncCursor });

    const back = await poll({ syncCursor: gone.syncCursor });

    expect(statements(back.sourceRecords).map((statement) => statement.key)).toContain("dentist@google.com");
    expect(back.withdrawn).toEqual(["parents-evening@google.com"]);
  });

  it("clips texts to what an Event keeps", async () => {
    const long = "x".repeat(600);
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:long\r\nDTSTART;VALUE=DATE:20260918\r\nSUMMARY:${long}\r\nLOCATION:${long}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const { poll } = icsPlugin({ fetch: server(calendar(body)).fetch });

    const [event] = statements((await poll()).sourceRecords);

    expect(event?.title).toHaveLength(500);
    expect(event?.place).toHaveLength(500);
  });

  it("gives an entry without a summary a placeholder title, and leaves out entries it cannot place", async () => {
    const entries = [
      "UID:untitled\r\nDTSTART;VALUE=DATE:20260918",
      "DTSTART;VALUE=DATE:20260918\r\nSUMMARY:No uid",
      "UID:no-start\r\nSUMMARY:No start",
      "UID:recurring\r\nDTSTART;VALUE=DATE:20260918\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Weekly",
      "UID:backwards\r\nDTSTART:20260915T160000Z\r\nDTEND:20260915T150000Z\r\nSUMMARY:Backwards",
    ];
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${entries.map((entry) => `BEGIN:VEVENT\r\n${entry}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`;
    const { poll } = icsPlugin({ fetch: server(calendar(body)).fetch });

    const { sourceRecords, attributes } = await poll();

    expect(statements(sourceRecords).map(({ key, title }) => [key, title])).toEqual([["untitled", "(No title)"]]);
    expect(attributes?.declared).toEqual([{ externalId: "calendar", name: "Calendar" }]);
  });

  it("starts afresh from a sync cursor it cannot read", async () => {
    const { poll } = icsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v1.ics"))).fetch });

    expect((await poll({ syncCursor: "not json" })).withdrawn).toEqual([]);
    expect((await poll({ syncCursor: JSON.stringify({ etag: null, known: "nonsense" }) })).withdrawn).toEqual([]);
  });

  it("gives up on a calendar that does not answer in time, with a temporary error", async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof globalThis.fetch;
    const { answer } = icsPlugin({ fetch: hanging, timeoutMs: 20 });

    expect(await answer()).toMatchObject({ status: 503, body: { kind: "temporary" } });
  });

  it("asks the calendar only for changes, and states nothing when there are none", async () => {
    const { fetch, requests } = server(calendar(fixture("family-v1.ics"), { etag: '"v1"' }), new Response(null, { status: 304 }));
    const { poll } = icsPlugin({ fetch });
    const first = await poll();

    const second = await poll({ syncCursor: first.syncCursor });

    expect(second).toEqual({ sourceRecords: [], syncCursor: first.syncCursor });
    expect(requests.map((request) => [request.url, request.headers.get("if-none-match")])).toEqual([
      [url, null],
      [url, '"v1"'],
    ]);
  });

  it("names the calendar apart from a run as an Admin named it, without downloading it", async () => {
    const { fetch, requests } = server();
    const { attributes } = icsPlugin({ fetch });

    expect(await attributes({ config: { plain: { name: "Clubs" }, secrets: { url } } })).toEqual({ declared: [{ externalId: "calendar", name: "Clubs" }], archived: [] });
    expect(requests).toEqual([]);
  });

  it("names the calendar apart from a run as it names itself, or Calendar", async () => {
    expect((await icsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch }).attributes()).declared).toEqual(
      (await icsPlugin({ fetch: server(calendar(fixture("family-v1.ics"))).fetch }).poll()).attributes?.declared,
    );
  });

  it("keeps an Admin's calendar name when the calendar has not changed", async () => {
    const { poll } = icsPlugin({ fetch: server(new Response(null, { status: 304 })).fetch });

    const result = await poll({ config: { plain: { name: " Clubs " }, secrets: { url } }, syncCursor: JSON.stringify({ etag: '"v1"', known: [] }) });

    expect(result.attributes).toEqual({ declared: [{ externalId: "calendar", name: "Clubs" }], archived: [] });
  });

  it("reads a webcal address over https, and an Admin's calendar name over the calendar's own", async () => {
    const { fetch, requests } = server(calendar(fixture("family-v1.ics")));
    const { poll } = icsPlugin({ fetch });

    const { sourceRecords, attributes } = await poll({ config: { plain: { name: "Clubs" }, secrets: { url: "webcal://calendar.example.org/basic.ics" } } });

    expect(requests[0]?.url).toBe("https://calendar.example.org/basic.ics");
    expect(sourceRecords[0]?.attributes).toEqual(["calendar"]);
    expect(attributes?.declared).toEqual([{ externalId: "calendar", name: "Clubs" }]);
  });

  it("places times without a known zone in their named zone, or else in the Family's", async () => {
    const entries = [
      "UID:named\r\nDTSTART;TZID=America/New_York:20260915T160000\r\nDTEND;TZID=America/New_York:20260915T170000",
      "UID:floating\r\nDTSTART:20260915T160000\r\nDTEND:20260915T170000",
      "UID:no-end\r\nDTSTART:20260915T160000Z",
      "UID:no-end-all-day\r\nDTSTART;VALUE=DATE:20260918",
      "UID:duration\r\nDTSTART:20260915T160000Z\r\nDURATION:PT45M",
    ];
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${entries
      .map((entry) => `BEGIN:VEVENT\r\n${entry}\r\nSUMMARY:Entry\r\nEND:VEVENT\r\n`)
      .join("")}END:VCALENDAR\r\n`;
    const { poll } = icsPlugin({ fetch: server(calendar(body)).fetch });

    const { sourceRecords } = await poll();

    expect(statements(sourceRecords).map(({ key, span }) => [key, span])).toEqual([
      ["named", timed("2026-09-15T20:00:00.000Z", "2026-09-15T21:00:00.000Z")],
      ["floating", timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z")],
      ["no-end", timed("2026-09-15T16:00:00.000Z", "2026-09-15T16:00:00.000Z")],
      ["no-end-all-day", { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-18" }],
      ["duration", timed("2026-09-15T16:00:00.000Z", "2026-09-15T16:45:00.000Z")],
    ]);
  });

  it("places a time in a zone only the calendar's own VTIMEZONE knows", async () => {
    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Custom Plus Two",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0200",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:custom",
      "DTSTART;TZID=Custom Plus Two:20260915T160000",
      "DTEND;TZID=Custom Plus Two:20260915T170000",
      "SUMMARY:Entry",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const { poll } = icsPlugin({ fetch: server(calendar(body)).fetch });

    const [event] = statements((await poll()).sourceRecords);

    expect(event?.span).toEqual(timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"));
  });

  it.each([
    { case: "an address that is gone", response: new Response("", { status: 404 }), status: 422, kind: "definite" },
    { case: "a refused address", response: new Response("", { status: 403 }), status: 422, kind: "definite" },
    { case: "a server error", response: new Response("", { status: 503 }), status: 503, kind: "temporary" },
    { case: "too many requests", response: new Response("", { status: 429 }), status: 503, kind: "temporary" },
    { case: "a request timeout", response: new Response("", { status: 408 }), status: 503, kind: "temporary" },
    { case: "an unreachable server", response: new TypeError("fetch failed"), status: 503, kind: "temporary" },
    { case: "a page that is no calendar", response: calendar("<html>Sign in</html>"), status: 422, kind: "definite" },
    { case: "an ICS file that is no calendar", response: calendar("BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\n"), status: 422, kind: "definite" },
  ])("fails on $case with a $kind error", async ({ response, status, kind }) => {
    const { answer } = icsPlugin({ fetch: server(response).fetch });

    const got = await answer();
    expect(got).toMatchObject({ status, body: { kind } });
  });

  it.each(["not an address", ""])("fails definitely on %j, which is no web address", async (address) => {
    const { answer } = icsPlugin({ fetch: server().fetch });

    expect(await answer({ config: { plain: {}, secrets: { url: address } } })).toMatchObject({ status: 422, body: { kind: "definite" } });
  });
});

describe("the ICS plugin over HTTP", () => {
  let http: Server;
  let base: string;
  beforeAll(async () => {
    http = await servePlugin(createIcsPlugin({ fetch: server(calendar(fixture("family-v1.ics")), calendar(fixture("family-v1.ics"))).fetch }), { host: "127.0.0.1" });
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
  });

  it("passes the contract tests by its URL", async () => {
    expect(await contractProblems(base, { config, now, languages: ["de"] })).toEqual([]);
  });
});
