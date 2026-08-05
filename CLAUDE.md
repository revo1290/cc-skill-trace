# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cc-skill-trace** — Claude Code / Codex CLI / GitHub Copilot CLI の Skill 発動デバッガー＆ビジュアライザー。  
どのスキルがいつ・なぜ自動発動されたかを追跡し、ブラウザレポートで可視化する OSS ツール。Claude Code 対応は stable、Codex CLI / GitHub Copilot CLI 対応は best-effort（`src/core/providers/types.ts` の `ProviderConfidence` 参照、#v3-multi-provider）。

## Commands

```bash
npm install           # 依存関係インストール
npm run build         # TypeScript → dist/ にコンパイル (tsc) + SKILL.md を dist/skill/ にコピー
npm run dev           # ウォッチモードでビルド
npm run typecheck     # 型チェックのみ（コンパイルなし）
npm run lint          # biome lint
npm run format:check  # biome format チェック（npm run format で自動修正）
npm test              # 全テスト（CLI サブプロセスを起動する integration.test.ts を含む）
npm run test:unit     # integration.test.ts を除いたユニットテストのみ
node dist/cli/index.js <cmd>   # ビルド後の動作確認
node --import tsx/esm src/cli/index.ts <cmd>   # ビルドせず src から直接実行
```

## Architecture

```
src/
├── core/
│   ├── types.ts      # 全型定義（SessionLogEntry, SkillInvocationEvent, HookPayload, EVENT_SCHEMA_VERSION）
│   ├── parser.ts     # ~/.claude/projects/**/*.jsonl を解析してスキル発動を抽出
│   ├── store.ts       # events.jsonl の読み書き・整合性チェック・修復・重複排除
│   ├── filter.ts       # EventFilter（--since/--skill/--grep 等）と日付・duration パーサ
│   ├── analyze.ts     # 自動発動診断・期間差分・コスト推定・ストリーク等の分析ロジック
│   ├── config.ts      # ~/.cc-skill-trace/{config.json,state.json} の読み書き、getStoreDir()
│   ├── utils.ts       # expandTilde 等の小さな汎用ヘルパー
│   └── providers/     # マルチエージェントCLI対応（#v3-multi-provider）
│       ├── types.ts        # Provider インターフェース、SkillDef、ProviderConfidence
│       ├── index.ts         # PROVIDERS レジストリ、getProvider()/resolveProviderId()
│       ├── skill-md.ts       # SKILL.md frontmatter パーサ（3プロバイダ共通、依存ゼロ）
│       ├── claude-code.ts     # parser.ts のラッパー（confidence: stable）
│       ├── codex.ts            # ~/.codex/sessions/**/*.jsonl 解析 + hooks.json 書き込み（best-effort）
│       ├── copilot.ts           # hook-capture のみ対応、scan 非対応（best-effort）
│       └── scan.ts               # claude-code 以外向けの汎用 extractAllInvocationsForProvider
├── skill/
│   └── SKILL.md       # Claude Code Skill 定義。/skill-trace スラッシュコマンドになる
└── cli/
    ├── index.ts        # CLI エントリポイント（commander）。各 register*Command を呼ぶだけの薄い配線
    ├── context.ts      # VERSION 解決・config の遅延ロード＆キャッシュ
    ├── options.ts       # 共通フィルタ系オプション定義（addFilterOptions 等）
    ├── ui.ts            # 色制御・確認プロンプト・ブラウザ起動・update チェック等のCLI共通ヘルパー
    ├── format.ts         # ターミナルダッシュボード（box-drawing + chalk。renderDashboard が中心）
    ├── web-report.ts     # スタンドアロン HTML レポート生成（Chart.js を CDN から読み込み）
    ├── atomic-write.ts   # settings.json の原子的書き込み（.tmp→rename、失敗時のtmp掃除）
    ├── hooks.ts           # settings.json 内の自前フックエントリ判定（command フィールド一致）
    ├── skill-md.ts        # SKILL.md の新旧比較（CRLF非依存）
    ├── follow.ts           # show --follow のオーバーラップ防止ガード
    ├── duration.ts         # clear --older-than 用の簡易 duration パーサ（filter.ts とは別系統）
    ├── version.ts          # package.json を辿ってバージョン解決（構造非依存）
    └── commands/
        ├── install.ts      # install / uninstall / status / doctor / init
        ├── scan.ts          # scan（--resume/--watch/--dry-run）、scanAndMerge 共有ロジック
        ├── show.ts           # show（デフォルトコマンド）、replay
        ├── stats.ts          # stats / list-skills / diagnose / check
        ├── export.ts          # export（json/csv/sql）/ report / clear / prune / tag
        ├── capture.ts          # hook-capture（Pre/PostToolUse 両方をここで処理）
        └── completion.ts        # completion（bash/zsh/fish）
```

### Data flow

1. `cc-skill-trace install` → `~/.claude/settings.json` に PreToolUse + PostToolUse hook を登録 + `~/.claude/skills/skill-trace/SKILL.md` をコピー
2. Claude Code セッション中に Skill tool が呼ばれる → PreToolUse hook → `hook-capture` サブコマンドが起動しイベントを追記
3. Skill tool 完了時 → PostToolUse hook → `hook-capture --post` が同一イベントに outcome/durationMs を追記
4. `hook-capture` は常に `{}` を返す（ブロックしない）。stdin 読み取りにはタイムアウトとサイズ上限がある
5. `cc-skill-trace show` → events.jsonl を読んで **ターミナルダッシュボード**を表示
6. `/skill-trace` (Claude Code 内) → SKILL.md の指示に従い Claude が `cc-skill-trace show --scan --terse` を実行して結果を解説
7. `cc-skill-trace report` → events.jsonl を読んで HTML を生成しブラウザで開く
8. `cc-skill-trace scan` → `~/.claude/projects/**/*.jsonl` を遡ってバックフィル。hook 由来イベントとは `selectNewEvents`（session+skill+args+時刻窓）で突合し二重登録を防ぐ。一致した場合は `enrichExistingEvents` が既存イベントの `triggerMessage`/`source` を `updateEvent` で事後補完する（#223）

### Key design decisions

- フックは **絶対に Claude Code をブロックしない**（例外をすべて握りつぶして exit 0）
- `hook-capture` は `src/cli/commands/capture.ts` の hidden サブコマンドとして実装（Pre/Post 両方をこの1ファイルで処理）
- `show` はデフォルトコマンド。`cc-skill-trace` だけで dashboard が出る
- ターミナル出力は box-drawing 文字 + ANSI カラーで視認性を最大化（`format.ts:renderDashboard`）。`NO_COLOR`/非TTY では自動的に無効化
- HTML レポートは依存ゼロのスタンドアロンファイル（Chart.js は CDN、ヒートマップ/ブランチ別グラフは自前CSS）
- イベントストアは JSONL。`v` フィールドでスキーマバージョン管理（v1 は暗黙、v2 で `recordedVia`/`tags`/`outcome`/`durationMs` 追加、v3 で `provider` 追加。`provider` 欠落は常に `"claude-code"` として扱う）
- `readEvents` はストリーミング読み取り＋行単位フィルタ。ファイル全体をメモリに載せない
- 設定は `~/.cc-skill-trace/config.json`（ユーザー編集用）と `state.json`（内部状態、last scan 等）に分離
- `CC_STORE_DIR` / `--store` でイベントストアの場所を切り替え可能
- `CC_DEBUG=1` または `--verbose` で診断ログを stderr に出力
- `CC_SCAN_CONCURRENCY` 環境変数でスキャン並列数を変更（デフォルト: 8）
- `CC_PROJECTS_DIR` 環境変数でスキャン対象ディレクトリを変更（先頭の `~/` はホームディレクトリに展開される。`/etc`,`/sys`,`/proc`,`/dev` 配下は `validateProjectsDir` が拒否する、#147）
- SKILL.md は `dist/skill/SKILL.md`（ビルド時に `scripts/copy-skill.mjs` がコピー）を優先し、`src/skill/SKILL.md`（`files` で同梱）にフォールバック
- `install`/`uninstall` は settings.json の hook を `hooks[].command` フィールドの完全一致で判定（`isCcSkillTraceHook`）。他ツールのフックを誤って触らない
- `CC_CODEX_HOME` / `CC_COPILOT_HOME` 環境変数でそれぞれ `~/.codex` / `~/.copilot` を上書き可能（`CC_PROJECTS_DIR` と同じパターン）。`providers/codex.ts`/`copilot.ts` はこれをモジュールロード時ではなく**呼び出し時**に読む関数（`codexHome()`/`copilotHome()`）にしている — トップレベル定数にすると `process.env` を書き換えるテストでサンドボックス化できなくなるため

### マルチプロバイダの発動検出方式 (#v3-multi-provider)

- **Claude Code**: `Skill` という専用 tool_use があるため確実に判定できる（stable）
- **Codex CLI**: 専用の skill tool 呼び出しは存在しない。実セッションログを調査した結果、モデルは skill 一覧で提示された `SKILL.md` の絶対パスを通常の shell 実行（`exec_command`）で読むことでスキルを"使う"ことが判明した（例: `sed -n '1,220p' /path/to/SKILL.md`）。そのため `function_call`/`custom_tool_call` の引数文字列に、インストール済みスキルの `SKILL.md` パスが部分文字列として含まれるかで判定している（best-effort だが scan 経路は実データで検証済み）
- **GitHub Copilot CLI**: ローカルに実行環境がなくドキュメントのみを根拠にしている。hook payload は camelCase（`sessionId`/`toolName`/`toolArgs`/`toolResult`）で、`toolArgs` を JSON.stringify した文字列に対して同じパス部分一致判定を使う。セッションログ形式が非公開のため `scan` 非対応、`hook-capture` のみ
- 上記の検出ロジックは `src/core/providers/{codex,copilot}.ts`（scan/list-skills 用）と `src/cli/commands/capture.ts`（hook-capture 用、`parseCodexPre`/`parseCopilotPre` 等）の両方に存在する。ペイロード形状は異なるが「インストール済みスキルの絶対パスを部分文字列マッチ」というロジック自体は共通

### 並行安全性の設計方針 (#161)

- `appendEvent` は `fs.appendFile`（O_APPEND）のみを使う純粋な追記操作。POSIX では PIPE_BUF 未満の単一 write は複数プロセスからでも atomic であり、本ツールが書き込む1イベント分の JSON 行はこれを大きく下回るため、**複数の `hook-capture` プロセスが同時に起動しても行の破損・上書きは起きない**。`src/cli/integration.test.ts` の「hook-capture cross-process concurrency」テストで実プロセスを並行起動して検証している。
- `pruneEvents`/`clearEvents`/`updateEvent`/`repairStore` は read-modify-write（全件読み込み→書き換え）であり、こちらは **プロセス内** の直列化（`enqueueWrite` の per-dir promise チェーン）のみを保証する。これらはユーザーが明示的に叩く CLI コマンドであり、同一ストアに対して複数プロセスから真に同時実行される可能性は低いと判断し、クロスプロセスのファイルロックは意図的に導入していない（同時実行するとどちらか一方の変更が失われ得る、という制約は許容している）。

### hook-capture と triggerMessage の制限

リアルタイムフック（`hook-capture`）経由で記録された時点のイベントには `triggerMessage` が含まれない。  
これは PreToolUse フックのペイロードに直前のユーザーメッセージが含まれないため（恒久的な制限）。

ただし `cc-skill-trace scan` を実行すると、同一の発動をセッションログから再検出し、`store.ts` の
`enrichExistingEvents`（#223）が欠落している `triggerMessage` を**既存の hook イベントに事後的に補完**する（新しい行として二重登録はしない）。
`source` も、hook 側が `"claude"`（不明/デフォルト）で scan 側がより確度の高い判定（例: Codex の `$SkillName` 明示呼び出し、
Claude Code のスラッシュコマンド判定）を持つ場合に `"user"` へ upgrade される。値の追加のみを行い、既存値の上書き・劣化（`"user"` → `"claude"`）はしない。
つまり `hook-capture` 単体では `triggerMessage` は恒久的に欠落するが、その後 `scan` を実行すれば事後的に埋まる。

### テストを追加する場所

新しいコアロジックは対応する `*.test.ts` に追加する（例: `core/filter.ts` → `core/filter.test.ts`）。CLI のエンドツーエンド動作（実プロセス起動・サンドボックス化した `HOME`/`CC_STORE_DIR`/`CC_PROJECTS_DIR`）は `cli/integration.test.ts` に集約している。
