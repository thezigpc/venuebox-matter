/**
 * Dev tool: a tiny matter.js controller to test the bridge without a phone.
 *
 *   npx tsx scripts/controller.ts <name> pair <11-digit code>     commission the bridge
 *   npx tsx scripts/controller.ts <name> list                     list bridged switches
 *   npx tsx scripts/controller.ts <name> on|off <endpoint>        switch one
 *   npx tsx scripts/controller.ts <name> label <text>             set this fabric's label
 *   npx tsx scripts/controller.ts <name> unpair                   remove our fabric
 *
 * State lives in ./.controllers/<name> (gitignored). Each name is its own fabric, so two
 * names test multi-admin ("Pair another app").
 */
import { Environment, Logger, Seconds, ServerNode } from "@matter/main";
import { BridgedDeviceBasicInformationClient } from "@matter/main/behaviors/bridged-device-basic-information";
import { OnOffClient } from "@matter/main/behaviors/on-off";
import { OperationalCredentialsClient } from "@matter/main/behaviors/operational-credentials";
import { FabricId } from "@matter/main/types";

const [name, cmd, arg] = process.argv.slice(2);
if (!name || !cmd) {
  console.error("usage: controller.ts <name> pair <code> | list | on <ep> | off <ep> | label <text> | unpair");
  process.exit(2);
}
const env = Environment.default;
env.vars.set("storage.path", `./.controllers/${name}`);
env.vars.set("path.root", `./.controllers/${name}`);
Logger.level = process.env.MATTER_LOG_LEVEL ?? "warn";

const index = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 50;
const node = await ServerNode.create({
  id: name,
  network: { port: 5600 + index },
  commissioning: { enabled: false },
  controller: { adminFabricId: FabricId(1 + index) },
} as never);
await node.start();

try {
  if (cmd === "pair") {
    const peer = await node.peers.commission({ pairingCode: arg, timeout: Seconds(90) } as never);
    console.log(`paired: ${peer.id}`);
    await list();
  } else {
    const peer = [...node.peers][0];
    if (!peer) throw new Error("not paired");
    if (cmd === "list") {
      await new Promise((r) => setTimeout(r, 4000)); // let the subscription refresh the cache
      await list();
    }
    else if (cmd === "on" || cmd === "off") {
      const ep = peer.parts.get(`ep${arg}`) ?? [...peer.endpoints].find((e) => String(e.number) === arg);
      if (!ep) throw new Error(`no endpoint ${arg}`);
      await (ep.commandsOf(OnOffClient) as any)[cmd]();
      console.log(`${cmd} sent to endpoint ${arg}`);
    } else if (cmd === "label") {
      const root = peer;
      const opcreds = root.commandsOf(OperationalCredentialsClient) as any;
      await opcreds.updateFabricLabel({ label: arg });
      console.log("label set");
    } else if (cmd === "unpair") {
      await peer.decommission();
      console.log("unpaired");
    }
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
await node.close();
process.exit();

async function list() {
  const peer = [...node.peers][0];
  for (const ep of peer.endpoints) {
    const info = ep.maybeStateOf(BridgedDeviceBasicInformationClient) as any;
    const onoff = ep.maybeStateOf(OnOffClient) as any;
    if (!info) continue;
    console.log(`  ${ep.number}\t${onoff?.onOff ? "ON " : "off"}\t${info.reachable ? "reachable  " : "unreachable"}\t${info.nodeLabel}`);
  }
}
