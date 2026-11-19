if (!process.versions.node.startsWith('24.') || !process.release.lts) {
  console.error(`DevHub requires Node.js 24 LTS. Current version: ${process.version}.`);
  process.exitCode = 1;
}
