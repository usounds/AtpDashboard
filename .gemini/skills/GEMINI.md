# Project Rito - 開発ガイドライン

## プロジェクト概要
Ritoは、Bluesky（AT Protocol）のエコシステムに向けたブックマークおよびフィード管理システムです。モノレポ構成を採用しており、フロントエンド、バックエンド、Chrome拡張機能、およびカスタムレキシコンの定義を含みます。

## 技術スタック
- **共通**: TypeScript, pnpm (Workspace)
- **Frontend**: Next.js (App Router), Tailwind CSS, Prisma
- **Protocol**: AT Protocol (Lexicons)
- **Database**: PostgreSQL (Prisma ORM)

## 開発ルールと規約

### 1. パッケージ管理
- 必ず `pnpm` を使用してください。

### 5. 命名規則・スタイル
- 変数・関数名: `camelCase`
- クラス・コンポーネント名: `PascalCase`
- ファイル名: 基本的に内容に応じた `camelCase` または `PascalCase` (Reactコンポーネント)
- 思考プロセスは英語で行いますが、ユーザーへの応答やドキュメント（特に指定がない場合）は日本語で行います。

### 6. コミットログ
すべて日本語で記載する
- feat : 新機能
- fix : バグ修正
- lib : ライブラリの更新

## 優先事項
1. **型の安全性**: TypeScriptの型定義を厳格に守り、`any` の使用を避けてください。
2. **パフォーマンス**: 特にフィードの取得や画像プロキシの処理において、効率的な実装を心がけてください。
3. **セキュリティ**: OAuthのクレデンシャルやセッション情報の扱いに細心の注意を払ってください。