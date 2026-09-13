/**
 * The super-admin console's media-storage page (migration 0149): the one
 * S3/Parspack connection every business's media library stores into, and the
 * daily price policy the billing tick charges business wallets with. The
 * bucket credential is the operator's root credential over every tenant's
 * files, which is why the write capability is `backup.manage` — the same
 * custody class as the deployment's other S3 connection.
 */
import { MediaConsoleManager } from "./media-console-manager";

export default function PlatformMediaPage() {
  return <MediaConsoleManager />;
}
