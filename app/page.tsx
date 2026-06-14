"use client";
// app/page.tsx
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  collection, addDoc, onSnapshot, query, orderBy, serverTimestamp,
  deleteDoc, doc, writeBatch, limit,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Game, GameMode, OrderPattern } from "@/types/molkky";

const PLAYER_NAMES_KEY = "molkky_player_names";

function modeName(mode: GameMode) {
  if (mode === "multi") return "Multi Sets Match";
  if (mode === "bestof") return "Best Sets Match";
  return "1 Set Match";
}

function HomePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [games, setGames] = useState<Game[]>([]);
  const [playerNames, setPlayerNames] = useState<string[]>(["", ""]);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>("multi");
  const [totalSets, setTotalSets] = useState(2);
  const [bestOfSets, setBestOfSets] = useState(2);
  const [orderPattern, setOrderPattern] = useState<OrderPattern>("reverse");
  const [deleting, setDeleting] = useState(false);

  // 直前の入力値を復元
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PLAYER_NAMES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          setPlayerNames(parsed);
        }
      }
    } catch {}
  }, []);

  // 入力値を保存
  useEffect(() => {
    try {
      localStorage.setItem(PLAYER_NAMES_KEY, JSON.stringify(playerNames));
    } catch {}
  }, [playerNames]);

  // ?new=1 でConf.を自動オープン
  useEffect(() => {
    if (searchParams.get("new") === "1") setShowForm(true);
  }, [searchParams]);

  useEffect(() => {
    const q = query(collection(db, "games"), orderBy("createdAt", "desc"), limit(20));
    const unsub = onSnapshot(q, (snap) => {
      setGames(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Game)));
    });
    return unsub;
  }, []);

  const addPlayer = () => setPlayerNames([...playerNames, ""]);
  const removePlayer = (i: number) => setPlayerNames(playerNames.filter((_, idx) => idx !== i));
  const updateName = (i: number, v: string) => {
    const next = [...playerNames]; next[i] = v; setPlayerNames(next);
  };
  const movePlayer = (from: number, to: number) => {
    if (to < 0 || to >= playerNames.length) return;
    const next = [...playerNames];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setPlayerNames(next);
  };
  const clearPlayers = () => setPlayerNames(["", ""]);

  // Recent Match: 最大20件（Firestore側でlimit済み）
  const visibleGames = games;

  const deleteGame = async (gameId: string) => {
    if (!confirm("このマッチを削除しますか？")) return;
    await deleteDoc(doc(db, "games", gameId));
  };

  const deleteAllGames = async () => {
    if (visibleGames.length === 0) return;
    if (!confirm(`表示中の${visibleGames.length}件をすべて削除しますか？`)) return;
    setDeleting(true);
    const batch = writeBatch(db);
    visibleGames.forEach((g) => batch.delete(doc(db, "games", g.id)));
    await batch.commit();
    setDeleting(false);
  };

  const createGame = async () => {
    const names = playerNames.map((n) => n.trim()).filter(Boolean);
    if (names.length < 2) return alert("プレイヤーは2人以上必要です");
    setCreating(true);
    const players = names.map((name, i) => ({
      id: `p${i}`, name,
      totalScore: 0, totalSetScore: 0,
      missCount: 0, isEliminated: false,
      turnOrder: i, setsWon: 0,
    }));
    const ref = await addDoc(collection(db, "games"), {
      createdAt: serverTimestamp(),
      status: "playing", winScore: 50, players,
      currentTurn: 0, winnerId: null, gameMode,
      totalSets: gameMode === "multi" ? totalSets : 1,
      bestOfSets: gameMode === "bestof" ? bestOfSets : 1,
      currentSet: 1,
      orderPattern,
    });
    router.push(`/game/${ref.id}`);
  };

  const statusLabel = (s: string) => {
    if (s === "playing") return { text: "Playing", cls: "bg-green-100 text-green-700" };
    if (s === "finished") return { text: "Fin.", cls: "bg-gray-100 text-gray-500" };
    return { text: "Waiting", cls: "bg-yellow-100 text-yellow-700" };
  };

  const modeLabel = (g: Game) => {
    if (g.gameMode === "multi") return `${g.totalSets} Sets`;
    if (g.gameMode === "bestof") return `First to ${g.bestOfSets}`;
    return "1 Set";
  };

  return (
    <div className="min-h-screen bg-white text-black" style={{ fontFamily: "メイリオ, Meiryo, sans-serif" }}>
      <header className="border-b border-gray-200 px-6 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mölkky Score Seva</h1>
          <p className="text-xs text-gray-400 mt-0.5">SCORE TRACKER</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="bg-black text-white font-bold text-sm px-5 py-2.5 rounded hover:bg-gray-800 transition-colors">
          ＋ New
        </button>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        {showForm && (
          <div className="border border-gray-200 rounded p-6 mb-8 bg-gray-50">
            <h2 className="font-bold text-lg mb-5">Conf.</h2>

            {/* プレイヤー入力（▲▼ボタンのみ） */}
            <div className="mb-5">
              <div className="space-y-2">
                {playerNames.map((name, i) => (
                  <div key={i} className="flex gap-2 items-center bg-white border border-gray-200 rounded px-2 py-1">
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => movePlayer(i, i - 1)} disabled={i === 0}
                        className="text-gray-400 hover:text-black disabled:opacity-20 text-[10px] leading-none px-1">▲</button>
                      <button onClick={() => movePlayer(i, i + 1)} disabled={i === playerNames.length - 1}
                        className="text-gray-400 hover:text-black disabled:opacity-20 text-[10px] leading-none px-1">▼</button>
                    </div>
                    <span className="text-gray-400 text-sm w-5">{i + 1}</span>
                    <input value={name} onChange={(e) => updateName(i, e.target.value)}
                      placeholder={`Mölkkist ${i + 1}`}
                      className="flex-1 bg-white border border-gray-200 px-3 py-2 text-sm text-black placeholder:text-gray-400 focus:outline-none focus:border-black rounded" />
                    {playerNames.length > 2 && (
                      <button onClick={() => removePlayer(i)} className="text-gray-400 hover:text-red-500 text-lg w-8 text-center">×</button>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <button onClick={addPlayer}
                  className="border border-gray-300 text-gray-600 text-sm px-4 py-2 rounded hover:border-black hover:text-black transition-colors">
                  ＋ Add
                </button>
                <button onClick={clearPlayers}
                  className="border border-gray-300 text-gray-600 text-sm px-4 py-2 rounded hover:border-red-400 hover:text-red-500 transition-colors">
                  Clear
                </button>
              </div>
            </div>

            {/* ゲームモード選択 */}
            <div className="mb-5">
              <div className="text-sm font-bold mb-3">Game Mode</div>
              <div className="space-y-2">
                <div onClick={() => setGameMode("single")}
                  className={`flex items-center gap-3 border rounded p-3 cursor-pointer transition-all ${gameMode === "single" ? "border-black bg-white" : "border-gray-200"}`}>
                  <input type="radio" name="mode" value="single" checked={gameMode === "single"} onChange={() => setGameMode("single")} className="accent-black pointer-events-none" />
                  <div>
                    <div className="font-bold text-sm">1 Set Match</div>
                  </div>
                </div>

                <div className={`border rounded p-3 transition-all ${gameMode === "multi" ? "border-black bg-white" : "border-gray-200"}`}>
                  <div onClick={() => setGameMode("multi")} className="flex items-center gap-3 cursor-pointer">
                    <input type="radio" name="mode" value="multi" checked={gameMode === "multi"} onChange={() => setGameMode("multi")} className="accent-black pointer-events-none" />
                    <div className="font-bold text-sm">Multi Sets Match</div>
                  </div>
                  {gameMode === "multi" && (
                    <div className="flex items-center gap-4 flex-wrap mt-2 pl-7">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Sets:</span>
                        <button type="button" onClick={() => setTotalSets((v) => Math.max(2, v - 1))}
                          className="w-8 h-8 border border-gray-300 rounded text-lg font-bold hover:bg-gray-100">−</button>
                        <span className="w-8 text-center text-sm font-bold">{totalSets}</span>
                        <button type="button" onClick={() => setTotalSets((v) => Math.min(20, v + 1))}
                          className="w-8 h-8 border border-gray-300 rounded text-lg font-bold hover:bg-gray-100">＋</button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Order:</span>
                        <select value={orderPattern}
                          onChange={(e) => setOrderPattern(e.target.value as OrderPattern)}
                          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-black">
                          <option value="reverse">Reverse</option>
                          <option value="slide">Slide</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                <div className={`border rounded p-3 transition-all ${gameMode === "bestof" ? "border-black bg-white" : "border-gray-200"}`}>
                  <div onClick={() => setGameMode("bestof")} className="flex items-center gap-3 cursor-pointer">
                    <input type="radio" name="mode" value="bestof" checked={gameMode === "bestof"} onChange={() => setGameMode("bestof")} className="accent-black pointer-events-none" />
                    <div className="font-bold text-sm">Best Sets Match</div>
                  </div>
                  {gameMode === "bestof" && (
                    <div className="flex items-center gap-4 flex-wrap mt-2 pl-7">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Wins needed:</span>
                        <button type="button" onClick={() => setBestOfSets((v) => Math.max(2, v - 1))}
                          className="w-8 h-8 border border-gray-300 rounded text-lg font-bold hover:bg-gray-100">−</button>
                        <span className="w-8 text-center text-sm font-bold">{bestOfSets}</span>
                        <button type="button" onClick={() => setBestOfSets((v) => Math.min(10, v + 1))}
                          className="w-8 h-8 border border-gray-300 rounded text-lg font-bold hover:bg-gray-100">＋</button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Order:</span>
                        <select value={orderPattern}
                          onChange={(e) => setOrderPattern(e.target.value as OrderPattern)}
                          className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-black">
                          <option value="reverse">Reverse</option>
                          <option value="slide">Slide</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button onClick={createGame} disabled={creating}
                className="bg-black text-white font-bold text-sm px-6 py-2 rounded hover:bg-gray-800 disabled:opacity-50 transition-colors">
                {creating ? "Starting..." : "Match Begin"}
              </button>
            </div>
          </div>
        )}

        {/* Game List */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs tracking-widest text-gray-400">Recent Match</h2>
            {visibleGames.length > 0 && (
              <button onClick={deleteAllGames} disabled={deleting}
                className="text-xs text-gray-400 hover:text-red-500 border border-gray-200 hover:border-red-300 rounded px-2 py-1 transition-colors disabled:opacity-50">
                {deleting ? "Deleting..." : "Delete All"}
              </button>
            )}
          </div>
          {visibleGames.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-12">No matches yet</p>
          ) : (
            <div className="space-y-2">
              {visibleGames.map((g) => {
                const { text, cls } = statusLabel(g.status);
                const winner = g.winnerId ? g.players.find((p) => p.id === g.winnerId)?.name : null;
                return (
                  <div key={g.id}
                    className="w-full border border-gray-200 rounded p-4 hover:border-gray-400 hover:bg-gray-50 transition-all flex items-start gap-2">
                    <button onClick={() => router.push(`/game/${g.id}`)} className="flex-1 text-left">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm text-black">{g.players.map((p) => p.name).join(" · ")}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{modeName(g.gameMode)} · {modeLabel(g)}</div>
                          {winner && <div className="text-xs text-yellow-600 mt-1">🏆 {winner} WIN!!</div>}
                          <div className="text-xs text-gray-400 mt-1">
                            {g.createdAt?.toDate?.()?.toLocaleString("ja-JP") ?? "—"}
                          </div>
                        </div>
                        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${cls}`}>{text}</span>
                      </div>
                    </button>
                    <button onClick={() => deleteGame(g.id)}
                      className="text-gray-300 hover:text-red-500 text-lg px-2 self-center transition-colors">
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <HomePageInner />
    </Suspense>
  );
}
