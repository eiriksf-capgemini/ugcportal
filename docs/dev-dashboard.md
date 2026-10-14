# Dev-dashbordet: slik bygger du opp sida

Dashbordet er én selvstendig HTML-fil, `.runtime/dashboard.html`, som
`scripts/dev-dashboard.mjs` skriver på nytt hvert 30. sekund. cmux viser fila i en
nettleserrute via `file://`. Sida er komprimert til å begynne med og utvider seg når du
klikker: hver bead og PR er én linje lukket, og hele posten åpen. Denne guiden forklarer
hvordan fila settes sammen, og hvordan du legger til egne datakilder, seksjoner, rader,
detaljer og varsler.

Kort kommandoreferanse:

```bash
node scripts/dev-dashboard.mjs                 # render én gang til .runtime/dashboard.html
node scripts/dev-dashboard.mjs --watch 30      # render hvert 30. sekund
node scripts/dev-dashboard.mjs --open          # åpne i en cmux-nettleserrute i tillegg
node scripts/dev-dashboard.mjs --sidebar       # sett piller i cmux-sidepanelet
node scripts/dev-dashboard.mjs --workspace     # åpne hele cmux-layouten
npm run dashboard                              # watch + open + sidebar
sh scripts/dashboard.sh --watch 30 --open --sidebar   # det samme, fra et skall uten node/npm
npx vitest run scripts/dev-dashboard.test.mjs  # testene
```

Sida oppdaterer seg bare så lenge en `--watch`-løkke kjører. Står det «Not refreshed
since …» øverst, er løkka død: start `npm run dashboard` på nytt.

Får du `command not found: npm` (eller `node`), er det fordi Node ligger under nvm, som
bare lastes i et innloggingsskall. Bruk `sh scripts/dashboard.sh` i stedet: den tar samme
argumenter som `dev-dashboard.mjs`, legger nyeste nvm-Node foran PATH hvis `node` mangler,
og er det `npm run dashboard` og cmux-layouten selv kjører gjennom.

Fire filer:

| Fil | Ansvar |
|---|---|
| `scripts/dev-dashboard.mjs` | CLI, henting av kilder, skriving av fila, cmux-piller og -arbeidsområde |
| `scripts/dashboard.sh` | Tynt skall-omslag: finner Node under nvm hvis det mangler på PATH, og kjører `dev-dashboard.mjs`. Det `npm run dashboard` og cmux-layouten bruker. |
| `scripts/lib/dashboard-data.mjs` | Ren logikk: kobling på tvers av kilder, «Needs you»-regler, hjelpere. Ingen I/O. |
| `scripts/lib/dashboard-html.mjs` | Rendrer HTML, CSS og sidens JavaScript fra dataene |

## 1. Dataflyten i fem steg

Alt skjer i `renderOnce()`:

```
gatherSources(repo)   →  ett Result-objekt per kilde (bd, gh, cmux, git)
joinRows(...)         →  én rad per bead i arbeid, koblet til PR, worktree og agent
buildAttention(...)   →  lista «Needs you», som strukturerte objekter
releaseProgress(...)  →  ferdig/totalt for release-etiketten og det som gjenstår, gruppert
renderHtml(...)       →  hele dokumentet som én streng
writeAtomic(...)      →  skriv til .tmp og rename, så nettleseren aldri laster en halv fil
```

Hver kilde er et `Result`:

```js
{ ok: true,  value: <parset JSON eller tekst> }
{ ok: false, error: "bd list --status: <første linje fra stderr>" }
```

Det er poenget med hele designet: en kilde som feiler blir en synlig feilboks i sin egen
seksjon og et «Source down»-punkt i «Needs you». Aldri en tom liste. En tom liste leses
som «ingenting å gjøre», og det er feil svar når verktøyet er nede. Det samme gjelder
tallene: et tall som bygger på en kilde som er nede, vises som `-`, ikke `0`, både i
flisene øverst, i tellingen bak seksjonsoverskriftene og i pillene i cmux-sidepanelet
(`countOf()` i `renderHtml()`, `sidebarPills()` i `dev-dashboard.mjs`).

Lister som vises i sin helhet, hentes uten tak som et ekte køomfang kan nå: `--limit 0`
(«ubegrenset») på `bd list --status in_progress`, `bd ready` og release-kilden, og
`--limit 200` på `gh pr list`, som ikke har noen ubegrenset verdi. En avkuttet liste ser
nemlig komplett ut, med flis og telling. «Recently merged» er bevisst kort (8).

### Seksjonen «Remaining in v0.7.0»

Beads knyttes til en release med en semver-etikett (`v0.7.0`), den samme `cut-release`
leser. Kilden `release` henter alle beads med en slik etikett, lukkede inkludert
(`bd list --all --label-pattern 'v*.*.*' --limit 0 --json`; `--limit 0` er «ubegrenset»,
standarden på 50 ville stille kuttet halen av en release på 80 beads). `releaseLabelOf()`
velger høyeste etikett blant beads som ikke er lukket, sammenlignet som semver, og
`releaseProgress()` gir ferdig/totalt pluss det som gjenstår i fire grupper: i arbeid,
klar, blokkert (etter `bd blocked`, siden en beads egen avhengighetsliste ikke skiller en
åpen blokkering fra en lukket) og utsatt. Lukkede beads teller bare i brøken. Seksjonen
har derfor to kilder: er `bd blocked` nede, viser den en feilboks for den i stedet for å
legge blokkerte beads under «Ready». Er alt lukket, sier seksjonen det i stedet for å vise
en tom liste, og sammenligner etiketten med versjonen i `package.json` (kilden
`version`): er etiketten `v<versjon>`, er releasen kuttet, ellers er det på tide å kutte
den. Finnes ingen etikett, sier den det. Radene har id `rel-<id>` så en bead som også står i «Ready» eller «Blocked» ikke
gir to elementer med samme id.

## 2. Legge til en ny datakilde

Eksempel: du vil vise de siste GitHub Actions-kjøringene.

**Steg 1.** Legg kallet inn i `gatherSources()` i `dev-dashboard.mjs`. Bruk `runJson` når
kommandoen gir JSON, `runText` ellers. Alle kallene kjører parallelt i `Promise.all`.

```js
const [inProgress, ready, /* ... */, runs] = await Promise.all([
  // ...eksisterende kall...
  runJson("gh", ["run", "list", "--limit", "5", "--json", "name,status,conclusion,createdAt,url"], repo),
]);
return { inProgress, ready, /* ... */, runs };
```

**Steg 2.** Les den ut i `renderHtml()` med fallback til tom liste:

```js
const runs = get("runs") ?? [];
```

**Steg 3.** Skriv seksjonen (kapittel 3). `buildAttention()` plukker opp den nye kilden
automatisk: den går gjennom alle nøklene i `sources` og legger til et «Source down»-punkt
for hver som har `ok: false`. Bunnteksten lister også alle kildene med grønn eller rød prikk.

Undersøk alltid den faktiske JSON-formen før du skriver koden:

```bash
gh run list --limit 1 --json name,status,conclusion | jq
bd list --status in_progress --json | jq '.[0] | keys'
cmux current --json | jq '.items[0]'
```

Et konkret eksempel på hvorfor: `bd blocked --json` legger blokkerende beads i feltet
`blocked_by`, mens `bd list --json` bruker `dependencies[].depends_on_id`. Første
versjon antok feil felt og viste `?` for alle blokkeringer.

## 3. Lage en seksjon

Alle seksjonene går gjennom `section()` i `dashboard-html.mjs`. Du gir den en nøkkel, en
tittel, antallet, kildene, de ferdig rendrede radene og teksten for tom tilstand:

```js
section({
  key: "runs",                       // blir id="sec-runs"; brukes av filter, "Show all" og lagret åpen/lukket
  title: "Latest CI runs",
  count: countOf(runs.length, "runs"),   // "-" når kilden er nede, aldri 0
  inputs: [[sources.runs, "gh run list"]], // [kilde, kommandonavn] for hver kilde radene bygger på
  rows: runs.map((r) => runRow(r, ctx)),
  emptyText: "No runs in the last day.",
  limited: Math.max(0, runs.length - QUEUE_LIMIT),   // > 0 gir en "Show all N"-knapp
})
```

`section()` velger selv mellom de tre tilstandene, i denne rekkefølgen:

1. **Nede:** én `<div class="error" role="alert">` med kommandonavn og feilmelding per
   kilde i `inputs` som er nede, og ingen rader. Bygger radene på flere kilder (release
   grupperer etter `bd blocked`, cmux filtrerer etter `git worktree list`), skal alle stå
   i `inputs`; rader laget av bare de kildene som svarte, ville vært gjetning.
2. **Tom:** `<p class="empty">` med `emptyText`.
3. **Innhold:** radene, pluss «Show all» hvis `limited > 0`.

I tillegg legger den alltid inn en skjult `<p class="nomatch">` som filteret viser når
søket treffer ingenting i akkurat denne seksjonen. Det er den tredje tomme tilstanden,
«filtrert til ingenting», og den må aldri forveksles med «ingenting her».

Legg seksjonen inn i `sections`-arrayen i `renderHtml()` på plassen den skal ha. Hvis den
skal ha en flis øverst, legg til en linje i `tiles`-arrayen rett over.

## 4. Lage en rad som kan utvides

En rad er et `<details>`-element med `<summary>` som den lukkede linja og `<div class="body">`
som innholdet. Nettleseren håndterer åpne og lukke, tastatur og fokus selv. Mønsteret, fra
`beadRow()`:

```js
function runRow(run, ctx, overflow = false) {
  const search = searchText(run.name, run.conclusion, run.status);   // det filteret matcher mot
  return `<details class="row${overflow ? " overflow" : ""}" id="run-${esc(run.id)}" data-search="${search}">
<summary>
<span class="id">${esc(run.id)}</span>
<span class="title" title="${esc(run.name)}">${esc(run.name)}</span>
<span class="meta">${ciIcon(summariseChecks([run]))} <span class="muted">${esc(run.conclusion ?? run.status)}</span> ${time(run.createdAt, ctx.now)}</span>
</summary>
<div class="body">${dl([
  ["Workflow", esc(run.workflowName)],
  ["Started", time(run.createdAt, ctx.now)],
  ["Link", link(run.url, "Open run")],
])}</div>
</details>`;
}
```

Reglene bak:

- **`id` er stabil** (`bead-<id>`, `pr-<nummer>`). Sida lagrer hvilke rader som er åpne i
  `localStorage` under disse id-ene, så raden du åpnet er fortsatt åpen etter neste reload.
  Ankerlenker (`#bead-ugcportal-h0ef`) bruker også id-en.
- **Summary er et grid med fire kolonner:** id, prioritet, tittel, meta. Tittelen har
  `min-width:0` og `text-overflow:ellipsis`, så den kuttes på én linje når raden er lukket
  og brytes over flere linjer når den er åpen. Hele tittelen står også som første felt i
  body, så ingenting identifiserende er borte for den som leser.
- **Lenker inne i summary** (`<a target="_blank">`) åpner lenken uten å toggle raden. Det er
  nettleserens standardoppførsel, ikke noe vi koder rundt.
- **`class="overflow"`** skjuler raden til brukeren trykker «Show all». Filteret viser
  likevel treff blant skjulte rader, så et søk aldri går glipp av noe.
- **`data-search`** er lowercase tekst av det filteret skal matche: id, tittel, PR-nummer,
  gren, scope og starten av beskrivelsen. Bruk `searchText()`; den kutter hver del til
  600 tegn så attributtet ikke eser ut.

`dl(rows)` lager body-innholdet som en definisjonsliste: en array av `[etikett, html]`.
Bruk `val(x)` for felt som kan være tomme (gir «Not set» i dempet farge) og `textBlock()`
for lange tekster. `textBlock()` kutter ved `TEXT_CAP` tegn og skriver hvor mange som
mangler og hvilken kommando som viser resten, i stedet for å laste 15 KB notater inn i
hver eneste rad.

## 5. Løkker, sortering og kutting

### Løkke over rader

Rader lages med `map` over dataene, så `section()` får en ferdig array:

```js
const readyRows = ready.map((b, i) => beadRow({ bead: b }, ctx, queueMeta(b, ctx), i >= QUEUE_LIMIT));
```

Det siste argumentet er `overflow`: alt fra og med rad nummer `QUEUE_LIMIT` skjules bak
«Show all». `QUEUE_LIMIT` er en eksportert konstant i `dashboard-data.mjs`.

### Sortering før løkka

Sorter en kopi av arrayen, aldri originalen, siden en annen seksjon kan bruke de samme
dataene. «Blocked» sorterer beads hvis blokkering er i arbeid først, fordi det er de som
snart kan tas:

```js
const sorted = [...blocked].sort((a, b) => {
  const aHot = blockersOf(a).some((id) => inProgressIds.has(id)) ? 0 : 1;
  const bHot = blockersOf(b).some((id) => inProgressIds.has(id)) ? 0 : 1;
  return aHot - bHot || (a.priority ?? 9) - (b.priority ?? 9);
});
```

### Tabell

Bruk tabell bare når det er fire kolonner eller færre og innholdet er kort. «cmux
workspaces» er den eneste tabellen. Den ligger i en `.tablewrap` som eier sin egen
scrolling, med sticky overskriftsrad, så sida aldri scroller sidelengs.

### Lister uten utvidelse

«Recently merged» er bare lenker med alder, så den bruker `<ul class="plain">` i stedet for
rader. Ikke lag et `<details>` som ikke har noe å vise når det åpnes.

## 6. Ikoner, chips, lenker og utheving

Ikonene er et innebygd SVG-sprite (`ICON_PATHS` i `dashboard-html.mjs`, Feather-stil,
24x24 strek). Sida refererer dem med `<use href="#i-navn">`, så alt ligger i den ene fila.

```js
icon("pr")                          // dekorativt, aria-hidden
icon("check-circle", "CI green", "ok")   // meningsbærende: role="img", aria-label og tooltip
```

Regelen: et ikon som *erstatter* tekst får alltid en etikett (andre argument). Et ikon som
står *ved siden av* tekst er dekorativt og får ingen. Legg til et nytt ikon ved å legge
path-strengen inn i `ICON_PATHS`; `icon()` kaster feil på ukjente navn, så en skrivefeil
stopper renderinga i stedet for å gi et tomt hull. Fargen følger `currentColor`, så
`ok`, `warn`, `bad` og `muted` som klasse er nok.

- **`ciIcon(kind)`** gir sjekk-, kryss-, klokke-, varsel- eller stiplet sirkel for
  CI-status med etikett «CI green» osv. `kind` kommer fra `summariseChecks()`, som bare
  sier `green` når hver sjekk er i `CHECKS_GREEN`; en konklusjon den ikke kjenner, blir
  `unknown` («CI unknown»), aldri grønn. Brukes i rader, i sjekklista og i kildelista i
  bunnteksten.
- **`reviewIcon(pr)`** gir øye, blyant, sjekk eller dokument for review-tilstanden.
- **`agentPill(state)`** gir en pille med aktivitets-, pause-, melding- eller cpu-ikon og
  skjult tekst (`.sr`) for skjermlesere.
- **`dl(rows)`** tar et valgfritt tredje element per rad, ikonnavnet for etiketten.

- **`beadChip(id, known, inProgressIds)`** lager en chip for en bead-id. Finnes beaden i
  dokumentet, blir chipen en hopp-lenke (`class="chip jump"`) som åpner raden og scroller
  dit. Er beaden i arbeid, får den `hot` og aksentfarge. Det er slik «Blocked» viser hva
  som løsner snart.
- **`link(href, text)`** gir `<a target="_blank" rel="noopener">`. Alle eksterne lenker går
  gjennom den.
- **`copyable(cmd)`** gir en kommando med «Copy»-knapp. Brukes under «Commands» i hver rad.

Ikoner og etiketter er oppslagstabeller (`CHECK_LABEL`, `AGENT_LABEL`), ikke if-kjeder,
så det er ett sted å endre en tekst.

## 7. Legge til en «Needs you»-regel

`buildAttention()` i `dashboard-data.mjs` returnerer strukturerte objekter, ikke ferdig
tekst, så rendereren kan legge på lenker:

```js
add("Merge conflict", `#${pr.number} for ${id}`, { anchor: `bead-${id}`, href: pr.url, severity: "bad" });
```

- `label` er to ord som vises i fet skrift.
- `text` er resten av setningen, uten etikett.
- `anchor` er id-en til raden det gjelder. Sida lager en «Show»-pille som åpner raden.
- `href` er en ekstern lenke, som regel PR-en. Sida lager en «PR»-pille.
- `severity` er `bad` (rød kant) eller `warn` (oransje kant, standard).

Terskler er eksporterte konstanter (`STALE_IN_PROGRESS_HOURS`, `REVIEW_WAIT_HOURS`), ikke
tall inne i koden, så testen kan importere dem. `REVIEW_WAIT_HOURS` måles på PR-ens egen
`updatedAt`, det samme feltet som teksten skriver ut.

En regel som slutter «det finnes ingen PR / worktree / bead» må vente på kildene den
slutter fra: med `prs` eller `worktrees` nede fyrer ikke «Unstarted claim», med
`inProgress` eller `prs` nede fyrer ikke «Orphan worktree», og «Stale» sier «its PR state
is unknown» i stedet for «has no PR». Bruk `up("kilde")` i `buildAttention()`.

Sjekk at regelen ikke fyrer på alt. Første versjon flagget «lease expired» på hver eneste
bead, fordi bd-leaser varer fem minutter og ingenting i agentflyten kjører `bd heartbeat`.
En regel som alltid fyrer blir ignorert, og da er den verre enn ingen regel. Mål mot ekte
data først:

```bash
node scripts/dev-dashboard.mjs | tail -1        # skriver "N need you"
```

## 8. Koble data på tvers av kilder

Ingen av verktøyene vet om hverandre. Koblingen er bead-id-en som ligger i grennavnet:

```
feat/ugcportal-kt3k-bead-validator   →  ugcportal-kt3k
/private/tmp/wt-kt3k                 →  (fallback: mappenavn)
```

`extractBeadId(text, prefix)` henter den ut, og krever repo-prefikset så et navn som
`pr-129-review` ikke feiltolkes. Sammenlign alltid hele id-en den returnerer, aldri med
`includes`: `ugcportal-abc` er en delstreng av både `ugcportal-abc.1` og
`ugcportal-abcd`. Både koblingen og «Merged, bead open» bruker den. `joinRows()` bygger tre oppslag (`prByBead`,
`wtByBead`, `itemsByCwd`) og slår opp i dem per bead. Skal du koble inn en ny kilde,
legg til et fjerde `Map` på samme måte.

Rendereren har i tillegg `known`, et `Map` over alle beads som finnes i dokumentet
(i arbeid, klare og blokkerte). Det er det `beadChip()` bruker for å avgjøre om en chip
kan bli en hopp-lenke.

To ting å huske:

- Stier normaliseres med `normalisePath()`. macOS gir `/private/tmp/…` fra git og
  `/tmp/…` fra skallet, og uten normalisering finner ikke agenten sin worktree.
- Rader som ikke matcher noen bead går til `unlinkedPrs` og `orphanWorktrees`, så de vises
  likevel.

## 9. Sidens JavaScript

Alt ligger i `JS`-konstanten nederst i `dashboard-html.mjs`. Ingen avhengigheter. Det den
gjør, i rekkefølge:

1. **Gjenoppretter tilstand** fra `localStorage`: åpne rader, lukkede seksjoner og hvilke
   seksjoner som har fått «Show all». Nøklene er prefikset med reponavnet.
2. **Filter.** Skriv i boksen, eller trykk `/`. Hver seksjon får `.fmiss` på rader som ikke
   matcher og viser «No rows here match» hvis alt forsvant. Teksten og om boksen hadde
   fokus ligger i `sessionStorage`, så en reload midt i skrivinga ikke tar fra deg
   markøren.
3. **Hopp-lenker** (`a.jump`) åpner målraden og seksjonen før de scroller, og viser skjulte
   rader om nødvendig. Målet slås opp med `document.getElementById`, ikke
   `querySelector`: i `#bead-ugcportal-qnq9.13` leser en selektor `.13` som en klasse.
4. **Copy-knapper** bruker `navigator.clipboard`, med `execCommand("copy")` som fallback for
   `file://`.
5. **Scrollposisjon** lagres og gjenopprettes.
6. **Reload-løkka.** Sida leser `<meta name="refresh-seconds">` og laster seg selv på nytt
   etter så mange sekunder. Den venter hvis filterboksen har fokus, tekst er markert, eller
   pekeren hviler på en åpen rad, men tvinger en reload etter fem intervaller. Alderen
   øverst («updated 12s ago») tikker hvert sekund, og etter tre intervaller uten ny fil
   vises «Not refreshed since …», så en død `--watch`-løkke er synlig.

Vil du legge til oppførsel: legg den inn i samme IIFE og bruk `ls`/`ss`-hjelperne for
lagring, så den overlever reload på samme måte som resten.

## 10. Teste det du har laget

Testene i `scripts/dev-dashboard.test.mjs` bruker fixtures formet som ekte output. Når du
legger til en kilde, seksjon eller rad:

1. Kopier et ekte JSON-objekt inn som fixture. Ikke dikt opp feltnavn.
2. Legg kilden inn i `allSourcesOk()` med `ok(...)`.
3. Test innholdstilstanden: at `page()` gir én `<details class="row"` per element, og at
   body inneholder feltene du la til.
4. Test nede-tilstanden: `page({ runs: down("gh run list: gh not found") })` og sjekk at
   feilboksen vises og at tom-teksten *ikke* vises.
5. Test escaping: legg `<script>` i en fixture-tittel og sjekk at det kommer ut som
   `&lt;script&gt;`.
6. Hvis du la til en «Needs you»-regel, test både at den fyrer og at den ikke fyrer rett
   under terskelen.

```bash
npx vitest run scripts/dev-dashboard.test.mjs
npx eslint scripts/dev-dashboard.mjs scripts/dev-dashboard.test.mjs scripts/lib/dashboard-*.mjs
```

## 11. Visningen i cmux

- **Nettleserruta** åpnes med `cmux browser open "file://.../.runtime/dashboard.html"`.
  Sida laster seg selv på nytt, så ingen server trengs. `writeAtomic()` skriver via `.tmp`
  og `rename`, så nettleseren aldri leser en halv fil.
- **Pillene i sidepanelet** settes av `updateSidebar()` med `cmux set-status`. Tre nøkler:
  `dash` (rød når noe trenger deg, grønn ellers), `beads` og `prs`. Legg til en pille ved å
  legge til ett kall til med en ny, unik nøkkel.
- **Layouten** ligger i `.cmux/cmux.json` (prosjektlokal) og som handlingen
  `ugcportal-dashboard` i `~/.config/cmux/cmux.json` (global, synlig overalt). Venstre
  kolonne er en nettleserflate. I den prosjektlokale fila står adressen som plassholderen
  `file://DASHBOARD_HTML`, så fila ikke inneholder én maskins hjemmekatalog;
  `--workspace` bytter den ut med `file://`-adressen til `--out` (som for `--workspace`
  alltid er `.runtime/dashboard.html`) før layouten gis til cmux. Høyre kolonne har
  Claude øverst og `--watch`-løkka nederst. Løkka rendrer én gang, navigerer alle
  nettleserflatene i arbeidsområdet til `file://$PWD/.runtime/dashboard.html` (det
  retter plassholderen når arbeidsområdet ble åpnet fra Command Palette, og laster fila
  hvis den ikke fantes da ruta åpnet), og går så over til å vente. Kommandoen sender
  stdout fra `cmux` til `/dev/null`, men aldri stderr. Den globale kopien har en fast
  adresse, siden den uansett er brukerens egen. Endrer du kommandoen i den ene fila,
  kopier den til den andre.
- **Node** ligger under nvm og er ikke på PATH i en fersk cmux-terminal. Derfor kjører
  layout-kommandoene gjennom `scripts/dashboard.sh`, som legger nyeste nvm-node foran PATH
  når `node` mangler. Den logikken ligger bare der, så en endring i hvor Node bor er én fil.

## 12. Sjekkliste før du er ferdig

- [ ] Seksjonen går gjennom `section()` og har `emptyText` og `sourceCmd`.
- [ ] Raden har stabil `id`, `data-search`, og hele tittelen i body.
- [ ] Alt fra data går gjennom `esc()`, også attributtverdier. Lange tekster gjennom `textBlock()`.
- [ ] Lange lister bruker `overflow` fra `QUEUE_LIMIT`.
- [ ] Ingen tabell med mer enn fire kolonner, og ingen `<details>` uten innhold i body.
- [ ] Ny terskel er en eksportert konstant.
- [ ] Fixture i testen er kopiert fra ekte output.
- [ ] `node scripts/dev-dashboard.mjs` kjørt mot ekte data, og «Needs you» inneholder bare ting som faktisk trenger deg.
- [ ] Ingen tankestrek i synlig tekst; bruk bindestrek eller «Not set».
- [ ] Ikoner som erstatter tekst har etikett; ikoner ved siden av tekst har ikke.
