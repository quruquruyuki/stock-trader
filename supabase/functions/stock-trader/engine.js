// 売買エンジンは、公開ページと同じ engine.js を GitHub のコミット固定で読み込む（中身が必ず一致する）
// エンジンを更新したら、コミットを push してから下の番号を新しいコミットに書きかえて関数をデプロイする
export * from "https://cdn.jsdelivr.net/gh/quruquruyuki/stock-trader@c22e8cc0ecd905d1fe0a1d1d89d3862563b80ad6/engine.js";
