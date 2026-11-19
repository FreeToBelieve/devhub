import { runnerIpcMessageSchema, runnerReceiptSchema } from '@devhub/contracts';

if (!process.send || !process.connected) {
  process.exitCode = 2;
} else {
  process.once('message', (message) => {
    const received = runnerIpcMessageSchema.safeParse(message);
    if (!received.success) {
      process.exitCode = 2;
      process.disconnect?.();
      return;
    }
    process.once('message', (receipt) => {
      const parsed = runnerReceiptSchema.safeParse(receipt);
      if (!parsed.success || parsed.data.bindingDigest !== received.data.claim.bindingDigest) process.exitCode = 2;
      process.disconnect?.();
    });
    process.send?.(received.data, (error) => {
      if (error) {
        process.exitCode = 2;
        if (process.connected) process.disconnect?.();
      }
    });
  });
}
