"use client";
// app/game/[id]/page.tsx
import { useState, useEffect, use, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  doc, onSnapshot, collection, query, orderBy,
  addDoc, updateDoc, deleteDoc, serverTimestamp, getDocs, limit,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Game, Player, Turn } from "@/types/molkky";

// ─── ゲームロジック ───────────────────────────────────────────────────
function calcNextState(players: Player[], currentTurn: number, inputScore: number, winScore: number) {
  const player = players[currentTurn];
  const isMiss = inputScore === 0;
  let newTotal = player.totalScore;
  let newMissCount = isMiss ? player.missCount + 1 : 0;
  let isEliminated = player.isEliminated;
  let wasReset = false;
  if (!isMiss) {
    newTotal = player.totalScore + inputScore;
    if (newTotal > winScore) { newTotal = Math.floor(winScore / 2); wasReset = true; }
  }
  if (newMissCount >= 3) isEliminated = true;
  const updatedPlayers = players.map((p, i) =>
    i === currentTurn ? { ...p, totalScore: newTotal, missCount: newMissCount, isEliminated } : p
  );
  // turnOrder順に次の(脱落していない)プレイヤーへ
  const n = updatedPlayers.length;
  const currentDisplayOrder = updatedPlayers[currentTurn].turnOrder;
  let nextTurn = currentTurn;
  for (let step = 1; step <= n; step++) {
    const targetOrder = (currentDisplayOrder + step) % n;
    const idx = updatedPlayers.findIndex((p) => p.turnOrder === targetOrder);
    if (idx !== -1 && !updatedPlayers[idx].isEliminated) { nextTurn = idx; break; }
  }
  return { updatedPlayers, nextTurn, wasReset, scoreAfter: newTotal };
}

// Reverse: 現在の表示順を反転
function reverseOrder(players: Player[]): Player[] {
  const n = players.length;
  return players.map((p) => ({ ...p, turnOrder: n - 1 - p.turnOrder }));
}
// Slide: 現在の表示順を1つ前にずらす（先頭が最後尾へ）
function slideOrder(players: Player[]): Player[] {
  const n = players.length;
  return players.map((p) => ({ ...p, turnOrder: (p.turnOrder - 1 + n) % n }));
}
function orderByTotalScore(players: Player[]): Player[] {
  const sorted = [...players].sort((a, b) => b.totalSetScore - a.totalSetScore);
  return players.map((p) => ({ ...p, turnOrder: sorted.findIndex((s) => s.id === p.id) }));
}
// orderPatternに応じて、現在の表示順(=手動入れ替え後の順序)を基準に次セットの順序を決める
function applyOrderPattern(players: Player[], pattern: string): Player[] {
  if (pattern === "reverse") return reverseOrder(players);
  if (pattern === "slide") return slideOrder(players);
  // fixed（既存データ互換用）: 現在の表示順をそのまま維持
  return players;
}

// セット内の勝者判定（最高得点者、isEliminated除く）
function getSetWinnerId(players: Player[]): string | null {
  const active = players.filter((p) => !p.isEliminated);
  if (active.length === 0) return null;
  const topScore = Math.max(...active.map((p) => p.totalScore));
  const winner = active.find((p) => p.totalScore === topScore);
  return winner?.id ?? null;
}

// セットが決着したか判定（誰かが winScore 到達、または active が1人以下）
function isSetOver(players: Player[], winScore: number): boolean {
  const active = players.filter((p) => !p.isEliminated);
  if (active.length <= 1) return true;
  if (active.some((p) => p.totalScore === winScore)) return true;
  return false;
}

// 複数セット最終勝者判定: setsWon優先、同数ならtotalSetScore
function getFinalChampion(players: Player[]): Player | null {
  if (players.length === 0) return null;
  const maxWins = Math.max(...players.map((p) => p.setsWon));
  const topByWins = players.filter((p) => p.setsWon === maxWins);
  if (topByWins.length === 1) return topByWins[0];
  const maxScore = Math.max(...topByWins.map((p) => p.totalSetScore));
  return topByWins.find((p) => p.totalSetScore === maxScore) ?? topByWins[0];
}

function prepareNextSet(game: Game, setWinnerId: string | null): Partial<Game> {
  const { gameMode, totalSets, bestOfSets, currentSet, players } = game;
  const nextSet = currentSet + 1;

  const updatedPlayers = players.map((p) => {
    const setsWon = setWinnerId === p.id ? p.setsWon + 1 : p.setsWon;
    const totalSetScore = p.totalSetScore + p.totalScore;
    return { ...p, totalScore: 0, missCount: 0, isEliminated: false, setsWon, totalSetScore };
  });

  // Best of: 誰かが必要勝利数に達したらゲーム終了
  if (gameMode === "bestof") {
    const champion = updatedPlayers.find((p) => p.setsWon >= bestOfSets);
    if (champion) {
      return { players: updatedPlayers, status: "finished", winnerId: champion.id };
    }
  }

  // 複数セット: 全セット終了でゲーム終了
  if (gameMode === "multi" && currentSet >= totalSets) {
    const champion = getFinalChampion(updatedPlayers);
    return { players: updatedPlayers, status: "finished", winnerId: champion?.id ?? null };
  }

  // 次セットのプレイヤー順
  let reorderedPlayers = updatedPlayers;
  if (gameMode === "bestof") {
    const maxWins = Math.max(...updatedPlayers.map((p) => p.setsWon));
    // 誰かが setsWon === bestOfSets-1 に達していれば、次セットは「決着しうるセット」
    const isDecider = maxWins === bestOfSets - 1;
    reorderedPlayers = isDecider
      ? orderByTotalScore(updatedPlayers)
      : applyOrderPattern(updatedPlayers, game.orderPattern ?? "reverse");
  } else {
    // multi: 最終セットも含めてパターン通りの順序
    reorderedPlayers = applyOrderPattern(updatedPlayers, game.orderPattern ?? "reverse");
  }

  const firstPlayer = reorderedPlayers.find((p) => p.turnOrder === 0) ?? reorderedPlayers[0];
  const firstIdx = reorderedPlayers.findIndex((p) => p.id === firstPlayer.id);

  return { players: reorderedPlayers, currentTurn: firstIdx, currentSet: nextSet, winnerId: null, status: "playing" };
}

// ─── メインコンポーネント ─────────────────────────────────────────────
export default function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [game, setGame] = useState<Game | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [showNextSet, setShowNextSet] = useState(false);
  const [setWinnerId, setSetWinnerId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // カウントダウンタイマー（得点入力5秒後に60秒からカウントダウン）
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startCountdown = () => {
    if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
    if (intervalTimerRef.current) clearInterval(intervalTimerRef.current);
    setCountdown(null);
    delayTimerRef.current = setTimeout(() => {
      setCountdown(60);
      intervalTimerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c === null) return null;
          if (c <= 0) {
            if (intervalTimerRef.current) clearInterval(intervalTimerRef.current);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    }, 5000);
  };

  const stopCountdown = () => {
    if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
    if (intervalTimerRef.current) clearInterval(intervalTimerRef.current);
    setCountdown(null);
  };

  useEffect(() => {
    return () => {
      if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
      if (intervalTimerRef.current) clearInterval(intervalTimerRef.current);
    };
  }, []);

  // ドラッグ＆ドロップ（プレイヤーカード並び替え） + タップ選択（スマホ用）
  const dragCardIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [selectedCardIdx, setSelectedCardIdx] = useState<number | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "games", id), (snap) => {
      if (snap.exists()) setGame({ id: snap.id, ...snap.data() } as Game);
    });
    return unsub;
  }, [id]);

  useEffect(() => {
    const q = query(collection(db, "games", id, "turns"), orderBy("timestamp", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setTurns(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Turn)));
    });
    return unsub;
  }, [id]);

  const submitScore = async (score: number) => {
    if (!game || game.status !== "playing" || submitting) return;
    setSubmitting(true);
    startCountdown();
    const currentPlayer = game.players[game.currentTurn];
    const { updatedPlayers, nextTurn, wasReset, scoreAfter } =
      calcNextState(game.players, game.currentTurn, score, game.winScore);

    await addDoc(collection(db, "games", id, "turns"), {
      playerId: currentPlayer.id, playerName: currentPlayer.name,
      score, timestamp: serverTimestamp(), scoreAfter, wasReset,
      setNumber: game.currentSet,
      snapshot: {
        players: game.players, currentTurn: game.currentTurn,
        winnerId: game.winnerId, status: game.status, currentSet: game.currentSet,
      },
    });

    // セット決着判定
    if (isSetOver(updatedPlayers, game.winScore)) {
      stopCountdown();
      const wid = getSetWinnerId(updatedPlayers);
      setSetWinnerId(wid);
      const updatedGame: Game = { ...game, players: updatedPlayers };

      if (game.gameMode === "single") {
        await updateDoc(doc(db, "games", id), {
          players: updatedPlayers, currentTurn: nextTurn,
          status: "finished", winnerId: wid,
        });
      } else if (game.gameMode === "bestof") {
        const next = prepareNextSet(updatedGame, wid);
        if (next.status === "finished") {
          await updateDoc(doc(db, "games", id), { ...next, currentTurn: nextTurn });
        } else {
          await updateDoc(doc(db, "games", id), { players: updatedPlayers, currentTurn: nextTurn, winnerId: null, status: "playing" });
          setShowNextSet(true);
        }
      } else {
        // multi
        if (game.currentSet >= game.totalSets) {
          const next = prepareNextSet(updatedGame, wid);
          await updateDoc(doc(db, "games", id), { ...next, currentTurn: nextTurn });
        } else {
          await updateDoc(doc(db, "games", id), { players: updatedPlayers, currentTurn: nextTurn, winnerId: null, status: "playing" });
          setShowNextSet(true);
        }
      }
    } else {
      await updateDoc(doc(db, "games", id), { players: updatedPlayers, currentTurn: nextTurn, winnerId: null, status: "playing" });
    }

    setSubmitting(false);
  };

  const confirmNextSet = async () => {
    if (!game) return;
    setShowNextSet(false);
    const next = prepareNextSet(game, setWinnerId);
    await updateDoc(doc(db, "games", id), next);
  };

  const undoLastTurn = async () => {
    if (!game || turns.length === 0) return;
    setUndoing(true);
    setShowNextSet(false);
    stopCountdown();
    const lastTurn = turns[0];
    const snapshot = (lastTurn as any).snapshot;
    if (snapshot) {
      await updateDoc(doc(db, "games", id), {
        players: snapshot.players, currentTurn: snapshot.currentTurn,
        winnerId: snapshot.winnerId, status: snapshot.status,
        currentSet: snapshot.currentSet ?? game.currentSet,
      });
    }
    const q = query(collection(db, "games", id, "turns"), orderBy("timestamp", "desc"), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) await deleteDoc(snap.docs[0].ref);
    setUndoing(false);
  };

  // プレイヤーカードのD&Dで turnOrder を入れ替え
  const swapTurnOrder = async (fromDisplayIdx: number, toDisplayIdx: number) => {
    if (!game || fromDisplayIdx === toDisplayIdx) return;
    const ordered = [...game.players].sort((a, b) => a.turnOrder - b.turnOrder);
    const fromPlayer = ordered[fromDisplayIdx];
    const toPlayer = ordered[toDisplayIdx];
    const newPlayers = game.players.map((p) => {
      if (p.id === fromPlayer.id) return { ...p, turnOrder: toPlayer.turnOrder };
      if (p.id === toPlayer.id) return { ...p, turnOrder: fromPlayer.turnOrder };
      return p;
    });
    await updateDoc(doc(db, "games", id), { players: newPlayers });
  };

  if (!game) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center" style={{ fontFamily: "メイリオ, Meiryo, sans-serif" }}>
        <div className="text-gray-400 text-sm animate-pulse">読み込み中...</div>
      </div>
    );
  }

  const isMultiSet = game.gameMode !== "single";
  const isFinalSet = game.gameMode === "multi" && game.currentSet >= game.totalSets;
  const currentPlayer = game.players[game.currentTurn];
  const winner = game.winnerId ? game.players.find((p) => p.id === game.winnerId) : null;
  const setWinnerName = setWinnerId ? game.players.find((p) => p.id === setWinnerId)?.name : null;
  const displayPlayers = [...game.players].sort((a, b) => a.turnOrder - b.turnOrder);

  // プレイヤーごとの現セット履歴
  const turnsByPlayer: Record<string, Turn[]> = {};
  game.players.forEach((p) => { turnsByPlayer[p.id] = []; });
  turns.filter((t) => t.setNumber === game.currentSet || !t.setNumber)
    .forEach((t) => { if (turnsByPlayer[t.playerId] !== undefined) turnsByPlayer[t.playerId].push(t); });

  const numKeys = [1,2,3,4,5,6,7,8,9,10,11,12];

  const modeName = () => {
    if (game.gameMode === "multi") return "Multi Sets Match";
    if (game.gameMode === "bestof") return "Best Sets Match";
    return "1 Set Match";
  };

  const modeInfo = () => {
    if (game.gameMode === "multi") return `Set ${game.currentSet} / ${game.totalSets}`;
    if (game.gameMode === "bestof") {
      const wins = game.players.map((p) => `${p.name}:${p.setsWon}`).join(" ");
      return `Set ${game.currentSet} · First to ${game.bestOfSets} · ${wins}`;
    }
    return null;
  };

  // 2セット目以降の表示ラベル: (W1-72) or (XW) (72)
  const playerLabel = (player: Player) => {
    if (!isMultiSet) return null;
    const total = player.totalSetScore + player.totalScore;
    if (game.gameMode === "bestof") {
      return { wins: null, text: `(W${player.setsWon}-${total})` };
    }
    // multi: setsWon があれば黄色で表示
    return { wins: player.setsWon > 0 ? `${player.setsWon}W` : null, text: `(${total})` };
  };

  // 次セットの全プレイヤー順
  const nextOrderNames = (() => {
    const next = prepareNextSet(game, setWinnerId);
    const nextPlayers = (next.players ?? game.players) as Player[];
    return [...nextPlayers].sort((a, b) => a.turnOrder - b.turnOrder).map((p) => p.name);
  })();

  return (
    <div className="min-h-screen bg-white text-black pb-10" style={{ fontFamily: "メイリオ, Meiryo, sans-serif" }}>
      <header className="border-b border-gray-200 px-4 py-4 flex items-center justify-between">
        <button onClick={() => router.push("/")} className="text-gray-400 hover:text-black text-sm transition-colors">← Recent Match</button>
        <div className="text-center">
          <h1 className="font-bold">Mölkky Score Seva</h1>
          <div className="text-xs text-gray-400">{modeName()}</div>
          {modeInfo() && <div className="text-xs text-gray-400">{modeInfo()}</div>}
        </div>
        <div className={`text-xs px-2 py-1 rounded font-medium ${game.status === "playing" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
          {game.status === "playing" ? "Playing" : "Fin."}
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-5 space-y-5">

        {/* 次セット確認ダイアログ（multi/bestof の途中セットのみ） */}
        {showNextSet && game.status === "playing" && (
          <div className="border-2 border-black rounded p-5 bg-gray-50 text-center">
            <div className="font-bold text-lg mb-1">Set {game.currentSet} Fin.</div>
            {setWinnerName && <div className="text-yellow-600 font-bold mb-2">🏆 {setWinnerName} WIN!!</div>}
            <div className="text-sm text-gray-500 mb-1">
              Next Turn: <span className="font-bold text-black">{nextOrderNames.join(" → ")}</span>
            </div>
            <div className="flex justify-center gap-4 text-sm mb-4 mt-2">
              {game.players.map((p) => (
                <div key={p.id} className="text-center">
                  <div className="text-xs text-gray-400">{p.name}</div>
                  <div className="font-bold">
                    {p.setsWon > 0 && <span className="text-yellow-500 mr-1">{p.setsWon}W</span>}
                    ({p.totalSetScore + p.totalScore})
                  </div>
                </div>
              ))}
            </div>
            <button onClick={confirmNextSet}
              className="bg-black text-white font-bold px-8 py-2 rounded hover:bg-gray-800 transition-colors">
              Next Set →
            </button>
          </div>
        )}

        {/* 勝利バナー */}
        {game.status === "finished" && (
          <div className="border-2 border-yellow-400 bg-yellow-50 p-4 text-center rounded">
            <div className="text-3xl mb-1">🏆</div>
            <div className="font-bold text-xl text-yellow-600">
              {winner ? `${winner.name} WIN!!` : "Fin."}
            </div>
            {isMultiSet && (
              <div className="flex justify-center gap-6 mt-3 text-sm">
                {game.players.map((p) => (
                  <div key={p.id} className="text-center">
                    <div className="text-xs text-gray-400">{p.name}</div>
                    {game.gameMode === "bestof"
                      ? <div className="font-bold">{p.setsWon} sets won</div>
                      : <div className="font-bold">
                          {p.setsWon > 0 && <span className="text-yellow-500 mr-1">{p.setsWon}W</span>}
                          Total ({p.totalSetScore})
                        </div>
                    }
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* プレイヤーカード 横並び（D&D対応） — 最終セット終了後（finished）は非表示 */}
        {!(game.status === "finished" && isMultiSet) && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${game.players.length}, minmax(0, 1fr))` }}>
          {displayPlayers.map((player, displayIdx) => {
            const isCurrent = game.status === "playing" && player.id === currentPlayer?.id;
            const label = playerLabel(player);
            return (
              <div
                key={player.id}
                className="flex flex-col gap-2"
                draggable={game.status === "playing"}
                onDragStart={() => { dragCardIdx.current = displayIdx; }}
                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(displayIdx); }}
                onDrop={() => {
                  if (dragCardIdx.current !== null) swapTurnOrder(dragCardIdx.current, displayIdx);
                  dragCardIdx.current = null; setDragOverIdx(null);
                }}
                onDragEnd={() => { dragCardIdx.current = null; setDragOverIdx(null); }}
                onClick={() => {
                  if (game.status === "finished" && isMultiSet) return;
                  if (selectedCardIdx === null) {
                    setSelectedCardIdx(displayIdx);
                  } else if (selectedCardIdx === displayIdx) {
                    setSelectedCardIdx(null);
                  } else {
                    swapTurnOrder(selectedCardIdx, displayIdx);
                    setSelectedCardIdx(null);
                  }
                }}
              >
                <div className={`border rounded p-3 text-center transition-all cursor-pointer active:scale-95 ${
                  dragOverIdx === displayIdx ? "opacity-60 scale-95" :
                  selectedCardIdx === displayIdx ? "border-blue-500 border-[3px] bg-blue-50" :
                  player.isEliminated ? "border-gray-100 bg-gray-50 opacity-40" :
                  isCurrent ? "border-orange-400 border-[3px] bg-orange-50" :
                  "border-gray-200"
                }`}>
                  <div className={`font-bold text-sm mb-1 ${player.isEliminated ? "line-through text-gray-400" : ""}`}>
                    {player.name}
                    {label && (
                      <span className="ml-1 text-xs font-normal">
                        {label.wins && <span className="text-yellow-500 font-bold mr-0.5">{label.wins}</span>}
                        <span className="text-gray-400">{label.text}</span>
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-bold text-red-500 mb-1 min-h-[16px]">
                    {player.missCount > 0 ? "×".repeat(player.missCount) : ""}
                  </div>
                  <div className={`text-3xl font-bold ${
                    player.missCount >= 2 && player.totalScore === game.winScore - 1
                      ? "text-red-600 animate-pulse"
                      : player.missCount >= 2
                      ? "text-red-600"
                      : player.totalScore === game.winScore ? "text-yellow-500" : "text-black"
                  }`}>
                    {player.totalScore}
                  </div>
                  {player.isEliminated && <div className="text-xs text-red-500 mt-1">脱落</div>}
                </div>

                {/* 履歴枠 */}
                <div className="border border-gray-200 rounded p-2 min-h-[40px]">
                  {(turnsByPlayer[player.id] ?? []).map((t) => (
                    <div key={t.id} className={`text-xs text-center ${
                      t.score === 0 ? "text-red-500 font-bold"
                      : t.wasReset ? "text-orange-500"
                      : "text-gray-600"
                    }`}>
                      {t.score === 0 ? "×" : t.wasReset ? `${t.score}(→${t.scoreAfter})` : `${t.score}`}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        )}

        {/* テンキー */}
        {game.status === "playing" && currentPlayer && !showNextSet && (
          <div className="border border-gray-200 rounded p-5">
            <div className="flex items-center justify-center mb-4">
              <div className="font-bold text-lg text-center">{currentPlayer.name}</div>
            </div>
            <div className="grid grid-cols-4 gap-2 mb-3">
              {numKeys.map((n) => (
                <button key={n} onClick={() => submitScore(n)} disabled={submitting}
                  className="py-4 text-xl font-bold rounded bg-gray-100 text-black hover:bg-gray-200 active:bg-black active:text-white disabled:opacity-50 transition-all">
                  {n}
                </button>
              ))}
            </div>
            <div className="flex items-stretch gap-2">
              <button onClick={() => submitScore(0)} disabled={submitting}
                className="flex-1 border border-red-300 text-red-500 font-bold text-sm py-3 rounded hover:bg-red-50 disabled:opacity-50 transition-colors">
                ×
              </button>
              <button onClick={undoLastTurn} disabled={undoing || turns.length === 0}
                className="flex-1 border border-gray-300 text-gray-600 text-sm py-3 rounded hover:border-black hover:text-black disabled:opacity-50 transition-colors">
                {undoing ? "..." : "Turn Back"}
              </button>
              <div className={`flex items-center justify-center w-14 font-bold text-lg rounded border ${
                countdown !== null && countdown <= 10 ? "border-red-300 text-red-600" : "border-gray-300 text-black"
              }`}>
                {countdown !== null ? countdown : ""}
              </div>
            </div>
          </div>
        )}

        {/* Turn Back（セット間・終了時） */}
        {turns.length > 0 && (game.status === "finished" || showNextSet) && (
          <button onClick={undoLastTurn} disabled={undoing}
            className="w-full border border-gray-300 text-gray-600 text-sm py-3 rounded hover:border-black hover:text-black disabled:opacity-50 transition-colors">
            {undoing ? "..." : "Turn Back"}
          </button>
        )}

        {/* 試合終了後: +New */}
        {game.status === "finished" && (
          <button onClick={() => router.push("/?new=1")}
            className="w-full bg-black text-white font-bold text-sm py-3 rounded hover:bg-gray-800 transition-colors">
            ＋ New
          </button>
        )}
      </div>
    </div>
  );
}
