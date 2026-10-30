// Shell script highlighting (CodeMirror legacy mode, ~5 KB), loaded on demand.

import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';

export const shLanguage = StreamLanguage.define(shell);
export const shExtension = () => shLanguage;
