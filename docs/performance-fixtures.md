# Performance fixtures

性能fixtureは、コンパイラ全体の時間を一つの数値として扱うのではなく、startup、
parse、type-check、emit、module resolution、incremental、watch、project-reference
buildで差が現れる場所を分けて観察するための合成入力である。どのfixtureも実際の
プロジェクト全体を代表するものではなく、結果は対象処理を強調した観測値として
読む。

## Fixture matrix

| Fixture | 強調する処理 | 測定方法 | 主な限界 |
|---|---|---|---|
| `startup-only` | プロセス起動とCLI初期化 | `--version`の完了時間 | project読込を含まず、短時間なのでOS schedulingの影響が大きい |
| `parse-heavy` | 大きなsyntax treeのparse | `noCheck`、`noEmit`で生成sourceをcompile | config読込、filesystem、bindingは除外されない |
| `type-heavy-scaled` | mapped、conditional、template literal、tuple typeの計算 | 生成した型の幅と件数をpresetで増やす | 実プロジェクトのすべての推論パターンを代表しない |
| `emit-heavy` | JavaScript emit | 毎回`dist`を消して通常emit | parseとtype-checkも含む |
| `declaration-heavy` | declaration emit | 毎回`dist`を消して`emitDeclarationOnly` | parseとsemantic analysisも含む |
| `module-resolution` | package exportsとdeclaration entrypointの解決 | 多数の生成packageを1ファイルからimport | OSとcompilerのfilesystem cacheを完全には制御しない |
| `incremental-initial` | fresh incremental build | 空の一時copyと新規`.tsbuildinfo`を計測 | 通常buildとの差にはcache書込みも含む |
| `incremental-no-change` | 変更なしの再build | preparation build後の2回目だけを計測 | preparation時間は含まない |
| `incremental-edit` | 1ファイル編集後の再build | preparation build後に1ファイルを編集し、2回目だけを計測 | 単一のimport chainに対する結果である |
| `watch-edit` | 編集から次の正常診断まで | 初回正常build後に1ファイルを編集し、次の正常cycleまでを計測 | fresh watch processを毎回使い、長時間稼働時の挙動は扱わない |
| `project-references-dag` | 深いproject-reference graphのbuild | layered DAGを`--build --force` | incremental DAG buildは測らない |

`small`、`type-heavy`、`many-files`など既存fixtureも同じrunに残るため、以前の
観測軸を失わずに新しいfixtureと比較できる。すべての通常fixtureはTS6、TS7
`--singleThreaded`、TS7 defaultの3条件で実行する。

## Size presets

`LAB_FIXTURE_PRESET`は`small`、`medium`、`large`のいずれかで、未指定時は
`medium`である。`npm run lab:quick`だけはCIや手元のsmoke test向けに`small`を
明示する。

| Scale | small | medium | large |
|---|---:|---:|---:|
| many-files files | 100 | 400 | 1,600 |
| parse files | 12 | 48 | 160 |
| statements / parse file | 120 | 240 | 480 |
| type files | 8 | 24 | 80 |
| instantiations / type file | 30 | 80 | 180 |
| emit files | 20 | 80 | 320 |
| declaration files | 16 | 64 | 240 |
| generated packages | 20 | 80 | 320 |
| incremental files | 40 | 160 | 640 |
| watch files | 20 | 80 | 320 |
| DAG layers | 3 | 4 | 6 |
| projects / DAG layer | 2 | 3 | 4 |

各列の値はすべて増加するため、同じマシンとcompiler versionでpresetを変えたrunを
作れば規模による傾向を比較できる。ただし、preset間の増加率は処理ごとに異なる。
smallからlargeへの所要時間が線形になることを仮定しない。

```bash
LAB_FIXTURE_PRESET=small npm run lab
LAB_FIXTURE_PRESET=medium npm run lab
LAB_FIXTURE_PRESET=large LAB_RUNS=20 LAB_WARMUPS=3 npm run lab
```

`LAB_FILE_COUNT`は後方互換のため残しており、選択したpresetのうち`many-files`の
件数だけを上書きする。他のscaleは変更しない。

## Reproducible generation

生成source、生成package、DAG projectは直接編集せず、必ず次のコマンドで作る。

```bash
LAB_FIXTURE_PRESET=medium npm run fixtures:generate
```

generatorは同じpresetから決定的なファイル名と内容を生成し、
`fixtures/.generated-preset.json`へ選択した全scaleを記録する。このmanifestと測定時の
環境が完全一致しない場合、benchmarkは開始前に失敗する。`benchmark`を単独実行する
場合は、生成時と測定時の環境を揃える。

```bash
LAB_FIXTURE_PRESET=large npm run fixtures:generate
LAB_FIXTURE_PRESET=large npm run benchmark
```

生成directoryとmanifestはGit管理対象外である。測定artifactの
`configuration.fixturePreset`と`configuration.replay.environment`には、runを
再現するためのpreset名、全scale、環境変数を保存する。

## Stateful measurements

incrementalとwatchは単一のcompiler invocationでは表現できないため、runnerが
fixtureをworkspace内の`.tmp/`へattemptごとにcopyする。variant間で`.tsbuildinfo`
や編集状態を共有せず、attempt終了後にcopyを削除する。

watchは初回buildを統計から除外し、編集直前から次の`Found 0 errors`までを測る。
processは観測後にrunnerが終了させるため、CPU timeとpeak RSSは誤解を招く部分値を
保存せず、理由付きの`unavailable`とする。incrementalのtimed compiler processは
通常どおりresource metricsの収集対象になる。

quick runやsmall presetの値を、すべてのTypeScript projectに一般化しない。規模の
傾向を述べる場合も、compiler version、hardware、warm-up、計測回数が揃ったrunを
使う。
