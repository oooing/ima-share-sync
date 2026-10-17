import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const inspector = require('@firecrawl/pdf-inspector');

console.log('Inspector exported:', inspector);
