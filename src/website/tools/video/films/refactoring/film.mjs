// Implements [WEB-DESIGN-MEDIA]. The "Refactoring & Code Actions" walkthrough
// (`refactoring`): an F# match completed and a function renamed across files,
// then C# fixes that generate a missing method and add a missing using.
//
//   node src/website/tools/video/film.mjs refactoring
import { LANGUAGE, scene } from '../../kit/acts/language.mjs';
import { AT_PIPELINE, AT_SESSIONS, missingCase, ready, renameAcrossFiles, repair } from '../../kit/acts/shop.mjs';
import { SHOP } from '../../kit/set.mjs';

export default {
  name: 'refactoring',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'narration.json',
  poster: { scene: 'generate', at: 7 },
  scenes: [
    ...ready(AT_PIPELINE, AT_SESSIONS),
    scene('fsharp', 1, 'Cmd+. on an F# match: generate the missing union case', missingCase, { speed: 2, chapter: 'FSharp.CodeAction' }),
    scene('rename', 2, 'Rename (F2) reaches every file in the project', renameAcrossFiles),
    scene('generate', 3, 'C#: call a method that doesn\'t exist, and generate it', repair(12, 'var receipt = Receipt(invoice);', 'Receipt', 'Generate method'), { chapter: 'CSharp.CodeAction' }),
    scene('using', 4, 'Use a type, and add its missing using', repair(13, 'var builder = new StringBuilder();', 'StringBuilder', 'using System.Text'), { chapter: 'CSharp.CodeAction' }),
  ],
};
