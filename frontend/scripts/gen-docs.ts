// npm run docs — regenerates docs/ddl-checks.md from the check catalogue.
import { writeFileSync } from 'node:fs';
import { ddlChecksMarkdown } from './ddldocs.ts';

const target = new URL('../../docs/ddl-checks.md', import.meta.url);
writeFileSync(target, ddlChecksMarkdown());
console.log('wrote', target.pathname);
