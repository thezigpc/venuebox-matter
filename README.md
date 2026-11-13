# Matter bridge for the Bar Games box

An integration module for the Bar Games box. It makes the box a **Matter bridge**, so a venue
with no Home Assistant can say *"Alexa, turn on Bingo Night"* or *"Hey Google, turn off the
Patio TV"*. Works with any Matter controller: Amazon Alexa, Google Home, Apple Home,
SmartThings.

| On the box | In the Matter app | What it does |
|---|---|---|
| Each scene | An on/off plug named after the scene | **On** runs the scene, then the switch turns itself off after about 2 s so it can be used again (routines and "turn on Bingo Night" both work). **Off** does nothing |
| Each TV the box can switch on and off | An on/off plug named after the TV | On/off switches the TV. The box can't read a TV's power, so the switch shows the last command. If the box refuses, the switch goes back. It shows as unreachable while the TV is offline |

The bridge follows the box: scenes and TVs added, renamed or removed on the box appear,
change or disappear in the apps. Each device keeps its Matter endpoint number (stored in
`/data`), so the apps keep their devices and routines across restarts and updates.

## For the venue

1. On the box, open **Settings → Smart home** and turn on **Matter**, approving what it asks
   for (scenes, TVs, and the local network for Matter discovery).
2. Scan the QR code shown there with the Alexa, Google Home or Apple Home app ("add a Matter
   device"), or type the 11-digit code. The app warns that the device isn't certified: that's
   expected, continue.
3. **Pair another app** opens a new code for 15 minutes, so Alexa and Apple Home can both
   control the box (Matter multi-admin).
4. **Forget all pairings** removes the box from every app and makes a new code.

## Development

```bash
npm install
npm test                      # unit tests (node:test via tsx)
npm run typecheck
```

**Against the SDK's mock box:**

```bash
npx bargames mock-box .       # terminal 1: scenes and fake TVs on :7199
BG_CORE_URL=http://127.0.0.1:7199 BG_GAME_TOKEN=dev-token BG_DATA_DIR=./.data npm run dev
```

**Against the fake core in `scripts/`**, which can also press report buttons, drop the stream
and edit the catalog:

```bash
npx tsx scripts/fake-core.ts                    # :7198
BG_CORE_URL=http://127.0.0.1:7198 BG_GAME_TOKEN=dev-token BG_DATA_DIR=./.data npm run dev
curl -X POST localhost:7198/dev/action/pair-another
curl -X POST "localhost:7198/dev/down?s=20"
curl localhost:7198/dev/report
```

**A test controller without a phone** (matter.js, in `scripts/controller.ts`). Each name is
its own fabric, so two names test multi-admin:

```bash
npx tsx scripts/controller.ts alexa pair <11-digit code>
npx tsx scripts/controller.ts alexa list
npx tsx scripts/controller.ts alexa on 2
npx tsx scripts/controller.ts alexa label Amazon
```

On Windows, a real phone needs UDP 5353 and 5540 allowed through the firewall, and the PC on
the same LAN as the phone. It's usually easier to test on the box itself.

### Layout

| File | What it does |
|---|---|
| `src/index.ts` | Wiring: box stream, report, button actions, start-up and shutdown |
| `src/bridge.ts` | Catalog → bridged devices, reachability, momentary scenes, TV power. Pure logic |
| `src/registry.ts` | Stable endpoint numbers and last-known devices in `/data/bridge.json` |
| `src/matter.ts` | matter.js: the node, the Aggregator, the plugs, and the pairing windows |
| `src/report.ts` | What the venue sees on the Smart home page |
| `src/identity.ts` | The random passcode and discriminator in `/data/identity.json` |

### What's in `/data`

- `identity.json`: the setup passcode and discriminator, made on first start and replaced by
  **Forget all pairings**.
- `bridge.json`: endpoint numbers per scene and TV id, and the box id and venue name.
- `matter/`: matter.js storage (fabrics, keys, attribute state).

None of this is ever logged or reported. Only the QR and manual code appear on the Smart home
page, and only while pairing is open.

### Identity

- Vendor id `0xFFF1` and product id `0x8000` are Matter's test ids for an uncertified device.
- Product name "Bar Games box", serial number = the box id, node label = the venue name.
- Matter listens on UDP 5540 and uses mDNS (UDP 5353). That's why the manifest asks for `lan`
  (host network).

## Release

Bump `version` and the `image` tag together in `bargames.json`, then push to `main`. The
**Publish image** workflow builds `linux/amd64` and pushes `ghcr.io/thezigpc/venuebox-matter:<version>`.
The GHCR package must be public.

matter.js is Apache-2.0.
