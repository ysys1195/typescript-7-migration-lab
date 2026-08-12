# Read-only local dashboard

ローカルdashboardは、保存済みのrunをCLI出力なしで読むための閲覧専用UIである。

```bash
npm run dev
```

serverは既定で`http://127.0.0.1:4173`を使用する。portだけをCLIまたは環境変数で
変更でき、hostは外部公開を避けるためloopbackへ固定する。

```bash
npm run dev -- --port 5000
LAB_DASHBOARD_PORT=5000 npm run dev
```

## Views

- Overview: standard 3 variantのmedian speedup、互換性signal、失敗件数
- Performance: TS6、TS7 `--singleThreaded`、TS7 defaultのfixture別barと全結果表
- Compatibility: diagnostics classificationとcompiler option migration catalog
- Diagnostics Diff: diagnosticsと終了コードを分けたstructured evidence
- Emit Diff: JavaScript／declaration file単位の一致状況とcompiler output
- Run History: complete runの切替と、選択baselineから表示runへのthreshold比較
- Environment: compiler、Node、machine、Git、preset、benchmark configuration

run selectorはlatest pointerを初期値とし、過去のcomplete runへ切り替えられる。
Historyの比較はIssue #9で定義したmachine／Node／測定条件／入力条件の比較可否を
そのまま表示し、条件が違うperformance rowをregressionとは断定しない。

## Data boundary

dashboard APIは次のread-only endpointだけを持つ。

| Endpoint | Data |
|---|---|
| `GET /api/latest` | 検証済みlatest pointer |
| `GET /api/runs` | completeな検証済みrun manifestの配列 |
| `GET /api/run/<run-id>` | manifest、benchmark、comparisonのversioned documents |
| `GET /api/compare?...` | schema検証済みのhistorical run comparison |

sourceは`schemas/result.schema.json`、`schemas/run-storage.schema.json`、
`schemas/run-comparison.schema.json`で検証されたdocumentに限定する。UI向けに別の
非versioned集計ファイルを生成せず、画面上の集計は読み込んだdocumentから計算する。

serverは静的dashboard asset以外のworkspace fileを配信しない。GETとHEAD以外は
`405`で拒否し、benchmark、shell、任意コマンド、artifact書込みを実行するendpointを
持たない。Content Security Policyはsame-originのscript、style、API接続だけを許可する。

このUIはローカル結果を読むためのもので、外部hostingやnetwork共有を対象にしない。
