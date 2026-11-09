# Family Agenda ICS plugin

The ICS calendar Source Type (`ics`) of [Family Agenda](https://github.com/artkoenig/family-agenda) as a stateless plugin container. It reads the Events of a calendar from its secret ICS address, such as Google Calendar's private address in iCal format, and answers the plugin contract over HTTP. It is built with the plugin kit (`docs/plugin-kit.md` of Family Agenda).

- Each poll downloads the calendar (with `If-None-Match` on its ETag) and states every entry's Event, keyed by UID; an entry gone since the last poll is withdrawn. The sync cursor holds the ETag and the UIDs seen.
- Recurring entries are left out for now.
- Configuration: `url` (secret, required; `webcal://` is read as `https://`) and `name` (optional; the calendar's own name otherwise), the name of its one Source Attribute, `calendar`.

## Running it

In `plugins.yml` of an Instance, with the calendar's host as egress (the address is a secret URL field, so the egress proxy does not learn the host from it):

```yaml
plugins:
  - id: ics
    image: ghcr.io/artkoenig/family-agenda-ics:0.1.0
    egress: [calendar.google.com:443]
```

The image listens on port 8080 and sends its requests through `HTTPS_PROXY` (`NODE_USE_ENV_PROXY=1`).

## Developing

Node 26 and pnpm (`corepack enable`). The plugin kit and the plugin contract are git dependencies on Family Agenda, pinned to one commit; raise both together.

- `pnpm install`
- `pnpm check`: typecheck, and the tests including the plugin kit's contract harness, in-process
- `pnpm start`: serves the plugin on `PORT` (8080)

While `artkoenig/family-agenda` is private, installing needs git access to it: locally over ssh (`git config --global url."git@github.com:".insteadOf https://github.com/`), in CI with the secret `FAMILY_AGENDA_TOKEN`, a token that can read it.

## Releasing

Raise `version` in `package.json` and `src/plugin.ts`, merge, and push the tag `vX.Y.Z` on main. CI then publishes `ghcr.io/artkoenig/family-agenda-ics` as `X.Y.Z` and `X.Y`.

## Licence

AGPLv3 (`LICENSE`). Contributions are licensed inbound as outbound under the [Developer Certificate of Origin](https://developercertificate.org/): sign off every commit (`git commit -s`). See `CONTRIBUTING.md`.
