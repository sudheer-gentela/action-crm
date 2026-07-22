#!/usr/bin/env node
/**
 * scripts/publish-skill.js
 *
 * DROP-IN LOCATION: backend/scripts/publish-skill.js
 *
 * Platform-scope skill publishing — the repo-based authoring flow:
 * author under backend/skills/<name>/, then publish the folder as a
 * versioned platform bundle. Platform scope is deliberately CLI-only
 * (deploy-adjacent, like migrations); org-scope publishing has an API route.
 *
 * Usage (from backend/, with DATABASE_URL set — Railway shell or local):
 *   node scripts/publish-skill.js <skill-name> <version> [--dry-run]
 *   node scripts/publish-skill.js outreach-email 1.0.0
 *   node scripts/publish-skill.js discovery-call-prep 1.1.0 --dry-run
 *
 * Rules enforced:
 *   - strict semver, strictly greater than any existing platform version
 *   - SKILL.md must exist; size/path caps apply
 *   - prints the checksum — record it in the release notes / commit message
 *
 * First-time baseline: publish every active skill at 1.0.0 so 'platform'
 * resolution takes over from disk explicitly:
 *   for s in outreach-email outreach-linkedin discovery-call-prep; do
 *     node scripts/publish-skill.js "$s" 1.0.0; done
 */

const skillBundles = require('../services/skillBundles.service');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [skillName, version] = args.filter(a => !a.startsWith('--'));

  if (!skillName || !version) {
    console.error('Usage: node scripts/publish-skill.js <skill-name> <version> [--dry-run]');
    process.exit(1);
  }

  if (dryRun) {
    const files = skillBundles.readSkillDirAsFiles(skillName);
    const checksum = skillBundles.computeChecksum(skillName, version, files);
    console.log(`[dry-run] ${skillName}@${version}`);
    console.log(`  files: ${Object.keys(files).length}`);
    for (const [p, c] of Object.entries(files)) {
      console.log(`    ${p} (${Buffer.byteLength(c, 'utf8')} bytes)`);
    }
    console.log(`  checksum: ${checksum}`);
    console.log('  (no database write performed)');
    process.exit(0);
  }

  try {
    const result = await skillBundles.publishFromDisk(skillName, {
      version, scope: 'platform', publishedBy: null,
    });
    console.log(`✅ Published platform bundle ${result.name}@${result.version}`);
    console.log(`   bundle id: ${result.bundleId}`);
    console.log(`   files:     ${result.fileCount}`);
    console.log(`   checksum:  ${result.checksum}`);
    console.log('   Record the checksum in the release commit.');
    process.exit(0);
  } catch (err) {
    console.error(`❌ Publish failed: ${err.message}`);
    process.exit(1);
  }
}

main();
