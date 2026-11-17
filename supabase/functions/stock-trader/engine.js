// 売買エンジンは、公開ページと同じ engine.js を GitHub のコミット固定で読み込む（中身が必ず一致する）
// エンジンを更新したら、コミットを push してから下の番号を新しいコミットに書きかえて関数をデプロイする
export * from "https://cdn.jsdelivr.net/gh/quruquruyuki/stock-trader@9458968ac69d80eee0225ca193ab35fb29dec98c/engine.js";
