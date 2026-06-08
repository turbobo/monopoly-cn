'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  GameState, Player, Tile, BOARD, BOARD_SIZE, COLOR_GROUPS,
  createGame, executeTurn, buyProperty, totalWealth, rollDice, calculateRent, checkBankrupt,
  auctionDecision, tradeDecision,
} from '@/lib/game-engine'
import { BoardRenderer } from '@/lib/board-renderer'
import {
  playDiceRoll, playDiceLand, playStepSound,
  playBuySound, playPaySound, playBankruptSound,
  setMuted, isMuted,
} from '@/lib/sound'

type Screen = 'menu' | 'setup' | 'game' | 'end'
type GameMode = 'ai' | 'local'

export default function Home() {
  const [screen, setScreen] = useState<Screen>('menu')
  const [mode, setMode] = useState<GameMode>('local')
  const [playerCount, setPlayerCount] = useState(2)
  const [initialMoney, setInitialMoney] = useState(1500)
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal')
  const [game, setGame] = useState<GameState | null>(null)
  const [messages, setMessages] = useState<string[]>([])
  const [buyPrompt, setBuyPrompt] = useState<{ tile: Tile; player: Player } | null>(null)
  const [highlightTile, setHighlightTile] = useState<number | undefined>()
  const [rolling, setRolling] = useState(false)
  const [diceResult, setDiceResult] = useState<string>('')
  const [soundOn, setSoundOn] = useState(true)
  const [paused, setPaused] = useState(false)
  const [sellMode, setSellMode] = useState(false)
  const [auctionState, setAuctionState] = useState<{
    tile: Tile; highestBid: number; highestBidder: Player | null; passedPlayers: number[]
  } | null>(null)
  const [tradeState, setTradeState] = useState<{
    step: 'selectPlayer' | 'selectTile' | 'setPrice' | 'waitResponse'
    targetPlayer?: Player; tile?: Tile; offer?: number
  } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<BoardRenderer | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // 初始化Canvas
  useEffect(() => {
    if (!canvasRef.current) return
    const r = new BoardRenderer(canvasRef.current)
    rendererRef.current = r
    r.resize()
    r.start()
    const onResize = () => r.resize()
    window.addEventListener('resize', onResize)
    return () => { r.stop(); window.removeEventListener('resize', onResize) }
  }, [])

  // 绘制棋盘 + 同步当前玩家
  useEffect(() => {
    if (!rendererRef.current || !game) return
    rendererRef.current.setCurrentPlayer(game.currentPlayer)
    rendererRef.current.draw(game.players, highlightTile)
  }, [game, highlightTile])

  // 滚动日志到底部
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [messages])

  // 开始游戏
  const startGame = useCallback(() => {
    const gs = createGame(mode, playerCount, initialMoney, difficulty)
    setGame(gs)
    const diffLabel = difficulty === 'easy' ? '简单' : difficulty === 'hard' ? '困难' : '普通'
    setMessages([`🎲 游戏开始！初始资金 ¥${initialMoney} | 难度：${diffLabel}` + (mode === 'ai' ? ' 你的对手是小火(激进)和阿平(平衡)' : ` ${playerCount}人本地对战`)])
    setScreen('game')
    setBuyPrompt(null)
    setHighlightTile(undefined)
    setDiceResult('')
    setPaused(false)
  }, [mode, playerCount, initialMoney, difficulty])

  // ===== 解析消息，触发棋盘视觉效果+音效 =====
  const triggerBoardEffects = useCallback((msgs: string[], playerIndex: number, gs: GameState) => {
    const r = rendererRef.current
    if (!r) return
    const player = gs.players[playerIndex]
    if (!player) return

    for (const msg of msgs) {
      if (msg.includes('购买了')) {
        r.showFloatingText(player.position, `🏠买了${BOARD[player.position].name}`, '#4ade80')
        playBuySound()
      }
      if (msg.includes('支付租金')) {
        const match = msg.match(/¥(\d+)/)
        if (match) r.showFloatingText(player.position, `-¥${match[1]}租金`, '#ef4444')
        playPaySound()
      }
      if (msg.includes('获得') || msg.includes('年终奖') || msg.includes('彩票') || msg.includes('股票') || msg.includes('红包')) {
        const match = msg.match(/¥(\d+)/)
        if (match) r.showFloatingText(player.position, `+¥${match[1]}`, '#4ade80')
      }
      if (msg.includes('花费') || msg.includes('维修') || msg.includes('罚款') || msg.includes('住院')) {
        const match = msg.match(/¥(\d+)/)
        if (match) r.showFloatingText(player.position, `-¥${match[1]}`, '#ef4444')
        playPaySound()
      }
      if (msg.includes('缴税')) {
        const match = msg.match(/¥(\d+)/)
        if (match) r.showFloatingText(player.position, `-¥${match[1]}税`, '#f59e0b')
        playPaySound()
      }
      if (msg.includes('入狱') || msg.includes('监狱')) {
        r.showFloatingText(7, '👮入狱！', '#ef4444')
      }
      if (msg.includes('破产')) {
        r.showFloatingText(player.position, '💀破产', '#dc2626')
        playBankruptSound()
      }
      if (msg.includes('卖出了')) {
        // 卖地消息：显示浮动文字标记已清除
        const nameMatch = msg.match(/卖出了\s*(.+?)（/)
        if (nameMatch) {
          const tileName = nameMatch[1]
          const tileIdx = BOARD.findIndex(t => t.name === tileName)
          if (tileIdx >= 0) r.showFloatingText(tileIdx, `🏷️卖出${tileName}`, '#f59e0b')
        }
      }
      if (msg.includes('决定不买')) {
        r.showCenterFloat(`${player.name}放弃`, '#94a3b8')
      }
    }
  }, [])

  // 执行回合结果的通用处理
  const finishTurn = useCallback((gs: GameState, actingPlayer: number, msgs: string[], dice: [number, number]) => {
    const total = dice[0] + dice[1]
    setHighlightTile(gs.players[actingPlayer]?.position)
    setMessages(m => [...m, ...msgs])
    setDiceResult(`${dice[0]} + ${dice[1]} = ${total}`)
    triggerBoardEffects(msgs, actingPlayer, gs)

    if (gs.phase === 'action' && !gs.players[gs.currentPlayer].isAI) {
      const tile = BOARD[gs.players[gs.currentPlayer].position]
      setBuyPrompt({ tile, player: gs.players[gs.currentPlayer] })
    }

    if (!gs.gameOver && gs.players[gs.currentPlayer].isAI) {
      setTimeout(() => handleAITurns(gs), 800)
    }

    if (gs.gameOver) {
      setTimeout(() => setScreen('end'), 1500)
    }
  }, [triggerBoardEffects])

  // 掷骰子（音效+骰子动画 → 逐格移动+步音效 → 执行回合）
  const handleRoll = useCallback(() => {
    if (!game || rolling || buyPrompt || paused) return
    setRolling(true)
    setDiceResult('')

    const dice = rollDice()
    const total = dice[0] + dice[1]
    const currentPlayer = game.players[game.currentPlayer]
    const fromTile = currentPlayer.position

    // 播放骰子翻滚音效
    playDiceRoll()
    rendererRef.current?.playDiceAnimation(dice, () => playDiceLand())

    // 监狱中的玩家：不播放移动动画
    if (currentPlayer.inJail) {
      const canEscape = currentPlayer.jailTurns >= 2 || dice[0] === dice[1]
      setTimeout(() => {
        if (canEscape) {
          // 出狱后需要移动动画
          const r = rendererRef.current
          if (r) {
            r.playMoveAnimation(
              currentPlayer.id, fromTile, total, currentPlayer.color, currentPlayer.avatar,
              () => {
                setGame(prev => {
                  if (!prev) return null
                  const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
                  const actingPlayer = gs.currentPlayer
                  const msgs = executeTurn(gs, dice)
                  finishTurn(gs, actingPlayer, msgs, dice)
                  return gs
                })
                setRolling(false)
              },
              () => playStepSound()
            )
          }
        } else {
          // 留在监狱，直接处理逻辑
          setGame(prev => {
            if (!prev) return null
            const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
            const actingPlayer = gs.currentPlayer
            const msgs = executeTurn(gs, dice)
            finishTurn(gs, actingPlayer, msgs, dice)
            return gs
          })
          setRolling(false)
        }
      }, 700)
      return
    }

    // 正常移动：骰子动画结束后开始移动
    setTimeout(() => {
      const r = rendererRef.current
      if (r) {
        r.playMoveAnimation(
          currentPlayer.id, fromTile, total, currentPlayer.color, currentPlayer.avatar,
          () => {
            setGame(prev => {
              if (!prev) return null
              const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
              const actingPlayer = gs.currentPlayer
              const msgs = executeTurn(gs, dice)
              finishTurn(gs, actingPlayer, msgs, dice)
              return gs
            })
            setRolling(false)
          },
          () => playStepSound()
        )
      }
    }, 700)
  }, [game, rolling, buyPrompt, finishTurn])

  // AI连续执行回合（含移动动画）
  const handleAITurns = useCallback((gs: GameState) => {
    const doOneAITurn = (state: GameState) => {
      if (state.gameOver || !state.players[state.currentPlayer].isAI) {
        setGame(state)
        if (state.gameOver) setTimeout(() => setScreen('end'), 1500)
        return
      }

      const actingIdx = state.currentPlayer
      const aiPlayer = state.players[actingIdx]
      const fromTile = aiPlayer.position
      const dice = rollDice()
      const total = dice[0] + dice[1]

      const r = rendererRef.current

      const processResult = (next: GameState, msgs: string[]) => {
        setMessages(m => [...m, ...msgs])
        triggerBoardEffects(msgs, actingIdx, next)
        setGame(next)
        if (!next.gameOver && next.players[next.currentPlayer].isAI) {
          setTimeout(() => doOneAITurn(next), 400)
        } else if (next.gameOver) {
          setTimeout(() => setScreen('end'), 1500)
        }
      }

      if (r) {
        playDiceRoll()
        r.playDiceAnimation(dice, () => playDiceLand())

        if (aiPlayer.inJail) {
          const canEscape = aiPlayer.jailTurns >= 2 || dice[0] === dice[1]
          setTimeout(() => {
            if (canEscape) {
              r.playMoveAnimation(
                aiPlayer.id, fromTile, total, aiPlayer.color, aiPlayer.avatar,
                () => {
                  const next = { ...state, players: state.players.map(p => ({ ...p, properties: [...p.properties] })) }
                  const msgs = executeTurn(next, dice)
                  processResult(next, msgs)
                },
                () => playStepSound()
              )
            } else {
              const next = { ...state, players: state.players.map(p => ({ ...p, properties: [...p.properties] })) }
              const msgs = executeTurn(next, dice)
              processResult(next, msgs)
            }
          }, 500)
        } else {
          setTimeout(() => {
            r.playMoveAnimation(
              aiPlayer.id, fromTile, total, aiPlayer.color, aiPlayer.avatar,
              () => {
                const next = { ...state, players: state.players.map(p => ({ ...p, properties: [...p.properties] })) }
                const msgs = executeTurn(next, dice)
                processResult(next, msgs)
              },
              () => playStepSound()
            )
          }, 500)
        }
      } else {
        const next = { ...state, players: state.players.map(p => ({ ...p, properties: [...p.properties] })) }
        executeTurn(next, dice)
        setGame(next)
      }
    }

    doOneAITurn(gs)
  }, [triggerBoardEffects])

  // 购买决定
  const handleBuy = useCallback((buy: boolean) => {
    if (!buyPrompt || !game || paused) return
    setGame(prev => {
      if (!prev) return null
      const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
      const player = gs.players[gs.currentPlayer]

      if (buy) {
        if (buyProperty(player, buyPrompt.tile.id)) {
          setMessages(m => [...m, `🏠 ${player.name} 购买了 ${buyPrompt.tile.name}（¥${buyPrompt.tile.price}）`])
          rendererRef.current?.showFloatingText(buyPrompt.tile.id, `🏠买了${buyPrompt.tile.name}`, '#4ade80')
          playBuySound()
        }
      } else {
        setMessages(m => [...m, `❌ ${player.name} 放弃购买 ${buyPrompt.tile.name}`])
        rendererRef.current?.showCenterFloat(`${player.name}放弃`, '#94a3b8')
        // 触发拍卖
        const otherPlayers = gs.players.filter(p => p.id !== player.id && !p.bankrupt)
        if (otherPlayers.length > 0) {
          gs.phase = 'auction'
          setAuctionState({
            tile: buyPrompt.tile,
            highestBid: Math.floor(buyPrompt.tile.price * 0.5),
            highestBidder: null,
            passedPlayers: [player.id],
          })
          setMessages(m => [...m, `🔨 ${buyPrompt.tile.name} 进入拍卖！起拍价 ¥${Math.floor(buyPrompt.tile.price * 0.5)}`])
          setBuyPrompt(null)
          return gs
        }
      }

      gs.phase = 'roll'

      // 检查破产卖地
      const br = checkBankrupt(player)
      for (const tileId of br.soldTiles) {
        setMessages(m => [...m, `🏷️ ${player.name} 被迫卖出了 ${BOARD[tileId].name}（6折 ¥${Math.floor(BOARD[tileId].price * 0.6)}）`])
        rendererRef.current?.showFloatingText(tileId, `🏷️卖出${BOARD[tileId].name}`, '#f59e0b')
      }
      if (br.bankrupt) {
        setMessages(m => [...m, `💀 ${player.name} 破产了！`])
        playBankruptSound()
      }

      let next = (gs.currentPlayer + 1) % gs.players.length
      while (gs.players[next].bankrupt) next = (next + 1) % gs.players.length
      if (next <= gs.currentPlayer) gs.round++
      gs.currentPlayer = next
      gs.phase = 'roll'

      if (!gs.gameOver && gs.players[gs.currentPlayer].isAI) {
        setTimeout(() => handleAITurns(gs), 1000)
      }

      return gs
    })
    setBuyPrompt(null)
  }, [buyPrompt, game, handleAITurns])

  // 主动变卖资产
  const handleSellProperty = useCallback((tileId: number) => {
    if (!game) return
    setGame(prev => {
      if (!prev) return null
      const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
      const player = gs.players[gs.currentPlayer]
      const tile = BOARD[tileId]
      const sellPrice = Math.floor(tile.price * 0.6)
      player.money += sellPrice
      player.properties = player.properties.filter(id => id !== tileId)
      setMessages(m => [...m, `🏷️ ${player.name} 变卖了 ${tile.name}（¥${sellPrice}）`])
      rendererRef.current?.showFloatingText(tileId, `🏷️卖出${tile.name}`, '#f59e0b')
      playPaySound()
      if (player.properties.length === 0) setSellMode(false)
      return gs
    })
  }, [game])

  // 拍卖出价
  const handleAuctionBid = useCallback((bid: number) => {
    if (!game || !auctionState) return
    setGame(prev => {
      if (!prev) return null
      const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
      const player = gs.players[gs.currentPlayer]
      if (bid > 0 && bid <= player.money) {
        setAuctionState(a => a ? { ...a, highestBid: bid, highestBidder: player } : null)
        setMessages(m => [...m, `🔨 ${player.name} 出价 ¥${bid}`])
      }
      return gs
    })
  }, [game, auctionState])

  // 拍卖放弃
  const handleAuctionPass = useCallback(() => {
    if (!game || !auctionState) return
    const currentP = game.players[game.currentPlayer]
    const newPassed = [...auctionState.passedPlayers, currentP.id]
    const remaining = game.players.filter(p => !p.bankrupt && !newPassed.includes(p.id))

    if (remaining.length === 0) {
      // 所有人放弃或只剩竞拍者
      if (auctionState.highestBidder) {
        setGame(prev => {
          if (!prev) return null
          const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
          const winner = gs.players.find(p => p.id === auctionState.highestBidder!.id)!
          winner.money -= auctionState.highestBid
          winner.properties.push(auctionState.tile.id)
          setMessages(m => [...m, `🔨 ${winner.name} 以 ¥${auctionState.highestBid} 拍得 ${auctionState.tile.name}！`])
          rendererRef.current?.showFloatingText(auctionState.tile.id, `🔨${winner.name}拍得`, '#4ade80')
          playBuySound()
          gs.phase = 'roll'
          return gs
        })
      } else {
        setMessages(m => [...m, `🔨 无人竞拍 ${auctionState.tile.name}，流拍`])
        setGame(prev => prev ? { ...prev, phase: 'roll' } : null)
      }
      setAuctionState(null)
    } else {
      setAuctionState({ ...auctionState, passedPlayers: newPassed })
      setMessages(m => [...m, `🔨 ${currentP.name} 放弃竞拍`])
      // AI自动出价
      const nextBidder = remaining[0]
      if (nextBidder.isAI) {
        setTimeout(() => {
          const aiBid = auctionDecision(nextBidder, auctionState.tile, auctionState.highestBid)
          if (aiBid > 0) {
            setAuctionState(a => a ? { ...a, highestBid: aiBid, highestBidder: nextBidder } : null)
            setMessages(m => [...m, `🔨 ${nextBidder.name} 出价 ¥${aiBid}`])
          }
          // AI也pass后继续检查
          const afterAIPassed = [...newPassed, ...(aiBid === 0 ? [nextBidder.id] : [])]
          if (aiBid === 0) {
            setAuctionState(a => a ? { ...a, passedPlayers: afterAIPassed } : null)
            setMessages(m => [...m, `🔨 ${nextBidder.name} 放弃竞拍`])
          }
        }, 600)
      }
    }
  }, [game, auctionState])

  // 拍卖结束（确认出价）
  const handleAuctionConfirm = useCallback(() => {
    if (!game || !auctionState || !auctionState.highestBidder) return
    setGame(prev => {
      if (!prev) return null
      const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
      const winner = gs.players.find(p => p.id === auctionState.highestBidder!.id)!
      winner.money -= auctionState.highestBid
      winner.properties.push(auctionState.tile.id)
      setMessages(m => [...m, `🔨 ${winner.name} 以 ¥${auctionState.highestBid} 拍得 ${auctionState.tile.name}！`])
      rendererRef.current?.showFloatingText(auctionState.tile.id, `🔨${winner.name}拍得`, '#4ade80')
      playBuySound()
      gs.phase = 'roll'
      return gs
    })
    setAuctionState(null)
  }, [game, auctionState])

  // 交易：选择对方玩家
  const handleTradeSelectPlayer = useCallback((targetPlayer: Player) => {
    setTradeState({ step: 'selectTile', targetPlayer })
  }, [])

  // 交易：选择地皮
  const handleTradeSelectTile = useCallback((tile: Tile) => {
    setTradeState(prev => prev ? { ...prev, step: 'setPrice', tile } : null)
  }, [])

  // 交易：发起交易
  const handleTradeOffer = useCallback((offer: number) => {
    if (!game || !tradeState?.targetPlayer || !tradeState?.tile) return
    const target = tradeState.targetPlayer
    const tile = tradeState.tile

    if (target.isAI) {
      const accepted = tradeDecision(target, tile, offer)
      if (accepted) {
        setGame(prev => {
          if (!prev) return null
          const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
          const buyer = gs.players[gs.currentPlayer]
          const seller = gs.players.find(p => p.id === target.id)!
          buyer.money -= offer
          seller.money += offer
          seller.properties = seller.properties.filter(id => id !== tile.id)
          buyer.properties.push(tile.id)
          setMessages(m => [...m, `🤝 ${buyer.name} 以 ¥${offer} 从 ${seller.name} 购得 ${tile.name}`])
          rendererRef.current?.showFloatingText(tile.id, `🤝交易成功`, '#4ade80')
          playBuySound()
          return gs
        })
      } else {
        setMessages(m => [...m, `🚫 ${target.name} 拒绝了交易（出价 ¥${offer} 买 ${tile.name}）`])
      }
      setTradeState(null)
    } else {
      setTradeState({ ...tradeState, step: 'waitResponse', offer })
    }
  }, [game, tradeState])

  // 交易：对方响应（本地多人）
  const handleTradeResponse = useCallback((accepted: boolean) => {
    if (!game || !tradeState?.targetPlayer || !tradeState?.tile || !tradeState?.offer) return
    if (accepted) {
      setGame(prev => {
        if (!prev) return null
        const gs = { ...prev, players: prev.players.map(p => ({ ...p, properties: [...p.properties] })) }
        const buyer = gs.players[gs.currentPlayer]
        const seller = gs.players.find(p => p.id === tradeState.targetPlayer!.id)!
        buyer.money -= tradeState.offer!
        seller.money += tradeState.offer!
        seller.properties = seller.properties.filter(id => id !== tradeState.tile!.id)
        buyer.properties.push(tradeState.tile!.id)
        setMessages(m => [...m, `🤝 ${buyer.name} 以 ¥${tradeState.offer} 从 ${seller.name} 购得 ${tradeState.tile!.name}`])
        rendererRef.current?.showFloatingText(tradeState.tile!.id, `🤝交易成功`, '#4ade80')
        playBuySound()
        return gs
      })
    } else {
      setMessages(m => [...m, `🚫 ${tradeState.targetPlayer!.name} 拒绝了交易`])
    }
    setTradeState(null)
  }, [game, tradeState])

  const currentPlayer = game?.players[game.currentPlayer]
  const isCurrentPlayerHuman = currentPlayer && !currentPlayer.isAI && !currentPlayer.bankrupt

  return (
    <div className="h-screen w-screen flex">
      {/* ===== 左侧：棋盘 ===== */}
      <div className="flex-1 flex items-center justify-center bg-[#0f1419] p-4 relative">
        <canvas ref={canvasRef} className="max-w-full max-h-full" />

        {/* 游戏控制栏（游戏中可见） */}
        {screen === 'game' && (
          <div className="absolute top-3 left-3 z-10 flex gap-2">
            {/* 暂停/继续 */}
            <button
              onClick={() => setPaused(!paused)}
              className="w-9 h-9 rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-lg hover:bg-black/60 transition-colors backdrop-blur-sm"
              title={paused ? '继续游戏' : '暂停游戏'}
            >
              {paused ? '▶️' : '⏸️'}
            </button>
            {/* 重新开始 */}
            <button
              onClick={() => {
                if (confirm('确定要重新开始游戏吗？')) {
                  startGame()
                }
              }}
              className="w-9 h-9 rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-lg hover:bg-black/60 transition-colors backdrop-blur-sm"
              title="重新开始"
            >
              🔄
            </button>
            {/* 音效开关 */}
            <button
              onClick={() => {
                const next = !soundOn
                setSoundOn(next)
                setMuted(!next)
              }}
              className="w-9 h-9 rounded-full bg-black/40 border border-white/10 flex items-center justify-center text-lg hover:bg-black/60 transition-colors backdrop-blur-sm"
              title={soundOn ? '关闭音效' : '开启音效'}
            >
              {soundOn ? '🔊' : '🔇'}
            </button>
          </div>
        )}

        {/* 暂停遮罩 */}
        {screen === 'game' && paused && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-30">
            <div className="text-center">
              <div className="text-6xl mb-4">⏸️</div>
              <h2 className="text-3xl font-bold text-white mb-6">游戏暂停</h2>
              <div className="flex gap-3">
                <button
                  onClick={() => setPaused(false)}
                  className="px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-500 rounded-full text-white font-bold hover:from-green-400 hover:to-emerald-400 transition-all"
                >
                  ▶️ 继续游戏
                </button>
                <button
                  onClick={() => {
                    if (confirm('确定要重新开始游戏吗？')) {
                      setPaused(false)
                      startGame()
                    }
                  }}
                  className="px-6 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-full text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all"
                >
                  🔄 重新开始
                </button>
                <button
                  onClick={() => {
                    setPaused(false)
                    setScreen('menu')
                  }}
                  className="px-6 py-3 bg-white/10 border border-white/20 rounded-full text-white font-bold hover:bg-white/20 transition-all"
                >
                  🏠 返回主菜单
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 主菜单 */}
        {screen === 'menu' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="text-center fade-in">
              <h1 className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-orange-400 to-red-400 mb-3">
                大富翁
              </h1>
              <p className="text-xl text-orange-300 mb-10 font-medium">中国行</p>
              <button
                onClick={() => setScreen('setup')}
                className="px-10 py-4 bg-gradient-to-r from-orange-500 to-red-500 rounded-full text-white font-bold text-lg hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 hover:scale-105"
              >
                开始游戏
              </button>
              <p className="text-gray-500 text-sm mt-6">掷骰子 · 买地皮 · 收租金</p>
            </div>
          </div>
        )}

        {/* 模式选择 */}
        {screen === 'setup' && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-8 max-w-md w-full mx-4 fade-in border border-white/10">
              <h2 className="text-2xl font-bold text-white mb-6 text-center">游戏设置</h2>

              <div className="mb-6">
                <label className="text-gray-400 text-sm mb-2 block">游戏模式</label>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => { setMode('local'); setPlayerCount(2) }}
                    className={`py-3 rounded-xl font-medium transition-all ${mode === 'local' ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                    👥 本地多人
                  </button>
                  <button onClick={() => { setMode('ai'); setPlayerCount(3) }}
                    className={`py-3 rounded-xl font-medium transition-all ${mode === 'ai' ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                    🤖 挑战AI
                  </button>
                </div>
              </div>

              <div className="mb-8">
                <label className="text-gray-400 text-sm mb-2 block">
                  {mode === 'ai' ? 'AI对手数量' : '玩家人数'}
                </label>
                <div className="flex gap-3">
                  {(mode === 'ai' ? [2, 3] : [2, 3, 4]).map(n => (
                    <button key={n} onClick={() => setPlayerCount(n)}
                      className={`flex-1 py-3 rounded-xl font-medium transition-all ${playerCount === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400'}`}>
                      {n}人
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-8">
                <label className="text-gray-400 text-sm mb-2 block">初始资金</label>
                <div className="grid grid-cols-4 gap-2">
                  {[800, 1000, 1500, 2000, 3000, 5000, 8000, 10000].map(n => (
                    <button key={n} onClick={() => setInitialMoney(n)}
                      className={`py-2.5 rounded-xl text-sm font-medium transition-all ${initialMoney === n ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
                      {n >= 10000 ? `${n / 10000}万` : `¥${n}`}
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-center">
                  <input
                    type="number"
                    value={initialMoney}
                    onChange={e => { const v = parseInt(e.target.value); if (v > 0) setInitialMoney(v) }}
                    className="w-32 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-center text-orange-300 font-bold text-sm focus:outline-none focus:border-orange-500/50 transition-colors"
                    min={100}
                    step={100}
                  />
                  <span className="text-gray-500 text-xs ml-1">自定义</span>
                </div>
              </div>

              <div className="mb-8">
                <label className="text-gray-400 text-sm mb-2 block">游戏难度</label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { key: 'easy' as const, label: '🌱 简单', desc: 'AI较弱，适合新手' },
                    { key: 'normal' as const, label: '⚖️ 普通', desc: '平衡体验' },
                    { key: 'hard' as const, label: '🔥 困难', desc: 'AI强势，挑战极限' },
                  ].map(d => (
                    <button key={d.key} onClick={() => setDifficulty(d.key)}
                      className={`py-3 px-2 rounded-xl text-center transition-all ${difficulty === d.key ? 'bg-orange-500/20 border-orange-500 text-orange-300 border' : 'bg-white/5 border border-white/10 text-gray-400 hover:border-white/20'}`}>
                      <div className="font-medium">{d.label}</div>
                      <div className="text-[10px] mt-1 opacity-70">{d.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <button onClick={() => setScreen('menu')}
                  className="flex-1 py-3 rounded-xl border border-white/10 text-gray-400 hover:border-white/20 transition-colors">
                  返回
                </button>
                <button onClick={startGame}
                  className="flex-[2] py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all">
                  开始！
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 游戏结束 */}
        {screen === 'end' && game && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-20">
            <div className="bg-[#1a2332] rounded-2xl p-8 max-w-md w-full mx-4 fade-in border border-white/10 text-center">
              <h2 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-orange-400 mb-2">
                🎉 游戏结束
              </h2>
              <p className="text-white text-xl font-bold mb-6">
                {game.players.find(p => p.id === game.winner)?.name} 获胜！
              </p>

              <div className="space-y-3 mb-6">
                {[...game.players].sort((a, b) => totalWealth(b) - totalWealth(a)).map((p, i) => {
                  const propVal = p.properties.reduce((sum, id) => sum + BOARD[id].price, 0)
                  return (
                    <div key={p.id} className="rounded-lg p-3"
                      style={{ background: p.color + '15', borderColor: p.color + '33', borderWidth: 1 }}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">{i === 0 ? '👑' : ''} {p.avatar}</span>
                          <div>
                            <span className="text-white font-bold">{p.name}</span>
                            {p.bankrupt && <span className="text-xs text-red-400 ml-2">破产</span>}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-amber-400 font-black text-lg">¥{totalWealth(p)}</div>
                          <div className="text-[10px] text-gray-500">总资产</div>
                        </div>
                      </div>
                      {/* 现金+地皮拆分 */}
                      <div className="flex gap-3 text-xs">
                        <div className="flex-1 bg-black/20 rounded-md px-2 py-1 text-center">
                          <div className="text-gray-500">现金</div>
                          <div className="font-bold" style={{ color: p.color }}>¥{p.money}</div>
                        </div>
                        <div className="flex-1 bg-black/20 rounded-md px-2 py-1 text-center">
                          <div className="text-gray-500">地皮 ({p.properties.length}块)</div>
                          <div className="font-bold text-amber-400">¥{propVal}</div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <button onClick={() => { setScreen('menu'); setGame(null) }}
                className="px-8 py-3 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all">
                再来一局
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===== 右侧：信息面板 ===== */}
      {screen === 'game' && game && (
        <div className="w-80 bg-[#1a2332] border-l border-white/10 flex flex-col h-screen overflow-hidden">
          {/* 当前玩家（带颜色条+大头像） */}
          <div className="p-4 border-b border-white/10 relative overflow-hidden">
            <div className="absolute inset-0 opacity-10" style={{ background: `linear-gradient(135deg, ${currentPlayer?.color}44, transparent)` }} />
            <div className="absolute top-0 left-0 w-full h-1" style={{ background: currentPlayer?.color }} />
            <div className="relative flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl shadow-lg"
                  style={{ background: currentPlayer?.color + '33', border: `2px solid ${currentPlayer?.color}` }}>
                  {currentPlayer?.avatar}
                </div>
                <div>
                  <div className="text-white font-bold text-lg">{currentPlayer?.name}的回合</div>
                  <div className="text-gray-500 text-xs">第{game.round}回合 / 共{game.maxRounds}回合</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-gray-500">现金 <span className="text-sm font-bold" style={{ color: currentPlayer?.color }}>¥{currentPlayer?.money}</span></div>
                <div className="text-xs text-gray-500">资产 <span className="text-sm font-bold text-amber-400">¥{currentPlayer ? totalWealth(currentPlayer) : 0}</span></div>
              </div>
            </div>
          </div>

          {/* 玩家列表（现金+资产分离显示+当前操作标识） */}
          <div className="p-3 border-b border-white/10 space-y-2 max-h-60 overflow-y-auto">
            {game.players.map(p => {
              const isCurrent = p.id === currentPlayer?.id
              const propValue = p.properties.reduce((sum, id) => sum + BOARD[id].price, 0)
              return (
                <div key={p.id}
                  className={`p-2.5 rounded-xl transition-all relative ${p.bankrupt ? 'opacity-30' : ''}`}
                  style={{
                    background: isCurrent ? p.color + '22' : 'rgba(255,255,255,0.03)',
                    borderWidth: isCurrent ? 1 : 0,
                    borderColor: isCurrent ? p.color + '55' : 'transparent',
                    boxShadow: isCurrent ? `0 0 0 2px ${p.color}44, 0 0 12px ${p.color}22` : 'none',
                  }}>
                  {/* 当前操作标识：左侧箭头 */}
                  {isCurrent && !p.bankrupt && (
                    <div className="absolute -left-1 top-1/2 -translate-y-1/2 flex items-center">
                      <div className="animate-pulse">
                        <svg width="14" height="20" viewBox="0 0 14 20" fill="none">
                          <path d="M0 10L14 0V20L0 10Z" fill={p.color}/>
                        </svg>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-lg relative"
                        style={{ background: p.color + '33', border: `1.5px solid ${p.color}` }}>
                        {p.avatar}
                        {/* 当前玩家小圆点指示器 */}
                        {isCurrent && !p.bankrupt && (
                          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border border-white animate-pulse" />
                        )}
                      </div>
                      <div>
                        <div className="text-sm text-white font-medium flex items-center gap-1.5">
                          {p.name}
                          {isCurrent && !p.bankrupt && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                              style={{ background: p.color + '44', color: p.color }}>
                              操作中
                            </span>
                          )}
                          {p.isAI && <span className="text-xs text-gray-500">
                            ({p.aiPersonality === 'aggressive' ? '激进' : p.aiPersonality === 'conservative' ? '保守' : '平衡'})
                          </span>}
                        </div>
                        <div className="text-xs" style={{ color: p.color }}>{p.properties.length}块地</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold" style={{ color: p.color }}>💰 ¥{p.money}</div>
                      <div className="text-xs text-amber-400 font-medium">🏠 ¥{propValue}</div>
                    </div>
                  </div>
                  {/* 总资产进度条 */}
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                      <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (p.money / totalWealth(p)) * 100 : 100}%`, background: p.color }} />
                      <div className="h-full rounded-r-full transition-all duration-500" style={{ width: `${totalWealth(p) > 0 ? (propValue / totalWealth(p)) * 100 : 0}%`, background: '#f59e0b' }} />
                    </div>
                    <span className="text-[10px] text-gray-400 whitespace-nowrap">共¥{totalWealth(p)}</span>
                  </div>
                </div>
              )
            })}
          </div>

          {/* 操作区 */}
          <div className="p-4 border-b border-white/10">
            {diceResult && !buyPrompt && (
              <div className="text-center text-sm text-amber-400 font-bold mb-2 bounce-in">
                🎲 {diceResult}
              </div>
            )}
            {auctionState ? (
              <div className="bounce-in">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">🔨</span>
                  <span className="text-white font-bold text-sm">拍卖: {auctionState.tile.name}</span>
                </div>
                <div className="text-xs text-gray-400 mb-2">
                  原价 ¥{auctionState.tile.price} · 当前最高 <span className="text-amber-400 font-bold">¥{auctionState.highestBid}</span>
                  {auctionState.highestBidder && <span> ({auctionState.highestBidder.name})</span>}
                </div>
                {isCurrentPlayerHuman && !auctionState.passedPlayers.includes(currentPlayer!.id) ? (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <button onClick={() => handleAuctionBid(auctionState.highestBid + 20)}
                        disabled={auctionState.highestBid + 20 > (currentPlayer?.money || 0)}
                        className="flex-1 py-2 bg-amber-600 rounded-lg text-white text-xs font-bold hover:bg-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        出价 ¥{auctionState.highestBid + 20}
                      </button>
                      <button onClick={() => handleAuctionBid(auctionState.highestBid + 50)}
                        disabled={auctionState.highestBid + 50 > (currentPlayer?.money || 0)}
                        className="flex-1 py-2 bg-amber-600 rounded-lg text-white text-xs font-bold hover:bg-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        +¥50
                      </button>
                    </div>
                    <button onClick={handleAuctionPass}
                      className="w-full py-2 bg-white/10 rounded-lg text-gray-300 text-xs hover:bg-white/20 transition-colors">
                      放弃竞拍
                    </button>
                  </div>
                ) : (
                  <button onClick={handleAuctionConfirm}
                    className="w-full py-2 bg-green-600 rounded-lg text-white text-xs font-bold hover:bg-green-500 transition-colors">
                    确认结果
                  </button>
                )}
              </div>
            ) : tradeState ? (
              <div className="bounce-in">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white font-bold text-sm">🤝 交易</span>
                  <button onClick={() => setTradeState(null)} className="text-xs text-gray-400 hover:text-white">取消</button>
                </div>
                {tradeState.step === 'selectPlayer' && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-gray-400 mb-1">选择交易对象：</div>
                    {game!.players.filter(p => p.id !== currentPlayer?.id && !p.bankrupt && p.properties.length > 0).map(p => (
                      <button key={p.id} onClick={() => handleTradeSelectPlayer(p)}
                        className="w-full flex items-center gap-2 p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-left">
                        <span>{p.avatar}</span>
                        <span className="text-xs text-white">{p.name}</span>
                        <span className="text-xs text-gray-500 ml-auto">{p.properties.length}块地</span>
                      </button>
                    ))}
                  </div>
                )}
                {tradeState.step === 'selectTile' && tradeState.targetPlayer && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-gray-400 mb-1">选择要购买的 {tradeState.targetPlayer.name} 的地皮：</div>
                    {tradeState.targetPlayer.properties.map(id => {
                      const tile = BOARD[id]
                      return (
                        <button key={id} onClick={() => handleTradeSelectTile(tile)}
                          className="w-full flex items-center justify-between p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ background: tile.color }} />
                            <span className="text-xs text-white">{tile.name}</span>
                          </div>
                          <span className="text-xs text-gray-400">原价¥{tile.price}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
                {tradeState.step === 'setPrice' && tradeState.tile && (
                  <div className="space-y-2">
                    <div className="text-xs text-gray-400">出价购买 <span className="text-white">{tradeState.tile.name}</span>（建议 ≥ ¥{Math.floor(tradeState.tile.price * 1.2)}）</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[1.0, 1.2, 1.5].map(mult => {
                        const price = Math.floor(tradeState.tile!.price * mult)
                        return (
                          <button key={mult} onClick={() => handleTradeOffer(price)}
                            disabled={price > (currentPlayer?.money || 0)}
                            className="py-2 rounded-lg bg-blue-600/80 text-white text-xs font-medium hover:bg-blue-500 transition-colors disabled:opacity-40">
                            ¥{price}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                {tradeState.step === 'waitResponse' && (
                  <div className="space-y-2">
                    <div className="text-xs text-gray-400 text-center">{tradeState.targetPlayer?.name} 是否接受 ¥{tradeState.offer} 卖出 {tradeState.tile?.name}？</div>
                    <div className="flex gap-2">
                      <button onClick={() => handleTradeResponse(true)} className="flex-1 py-2 bg-green-600 rounded-lg text-white text-xs font-bold">接受</button>
                      <button onClick={() => handleTradeResponse(false)} className="flex-1 py-2 bg-red-600/80 rounded-lg text-white text-xs font-bold">拒绝</button>
                    </div>
                  </div>
                )}
              </div>
            ) : sellMode && currentPlayer ? (
              <div className="bounce-in">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white font-bold text-sm">变卖资产（6折）</span>
                  <button onClick={() => setSellMode(false)}
                    className="text-xs text-gray-400 hover:text-white transition-colors">
                    返回
                  </button>
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {currentPlayer.properties.map(id => {
                    const tile = BOARD[id]
                    const sellPrice = Math.floor(tile.price * 0.6)
                    return (
                      <div key={id} className="flex items-center justify-between p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: tile.color }} />
                          <span className="text-xs text-white">{tile.name}</span>
                        </div>
                        <button onClick={() => handleSellProperty(id)}
                          className="text-xs px-2.5 py-1 rounded-md bg-amber-600/80 text-white font-medium hover:bg-amber-500 transition-colors">
                          卖 ¥{sellPrice}
                        </button>
                      </div>
                    )
                  })}
                </div>
                {currentPlayer.properties.length === 0 && (
                  <div className="text-xs text-gray-500 text-center py-2">没有可变卖的资产</div>
                )}
              </div>
            ) : buyPrompt ? (
              <div className="bounce-in">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">{buyPrompt.tile.emoji}</span>
                  <span className="text-white font-bold">{buyPrompt.tile.name}</span>
                </div>
                <div className="text-xs text-gray-400 mb-3">
                  价格 ¥{buyPrompt.tile.price} · 基础租金 ¥{buyPrompt.tile.rent[0]}
                  {buyPrompt.tile.rent[2] && ` · 全套租金 ¥${buyPrompt.tile.rent[2]}`}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleBuy(true)}
                    className="flex-1 py-2.5 bg-green-600 rounded-lg text-white text-sm font-bold hover:bg-green-500 transition-colors shadow-lg shadow-green-600/30">
                    💰 购买
                  </button>
                  <button onClick={() => handleBuy(false)}
                    className="flex-1 py-2.5 bg-white/10 rounded-lg text-gray-300 text-sm hover:bg-white/20 transition-colors">
                    跳过
                  </button>
                </div>
              </div>
            ) : isCurrentPlayerHuman && !rolling ? (
              <div className="space-y-2">
                <button onClick={handleRoll}
                  className="w-full py-3.5 bg-gradient-to-r from-orange-500 to-red-500 rounded-xl text-white font-bold hover:from-orange-400 hover:to-red-400 transition-all shadow-lg shadow-orange-500/30 active:scale-95 text-lg">
                  🎲 掷骰子
                </button>
                {currentPlayer && currentPlayer.properties.length > 0 && (
                  <button onClick={() => setSellMode(true)}
                    className="w-full py-2 rounded-lg border border-amber-500/30 text-amber-400 text-xs font-medium hover:bg-amber-500/10 transition-colors">
                    🏷️ 变卖资产
                  </button>
                )}
              </div>
            ) : (
              <div className="text-center text-gray-500 py-3 animate-pulse">
                {rolling ? '🎲 骰子翻滚中...' : '⏳ 等待中...'}
              </div>
            )}
          </div>

          {/* 游戏日志 */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 pt-3 text-xs text-gray-500 font-medium">游戏日志</div>
            <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-1.5">
              {messages.map((msg, i) => {
                const isLast = i === messages.length - 1
                return (
                  <div key={i} className={`text-xs transition-all ${isLast ? 'text-white font-medium fade-in' : 'text-gray-500'}`}>
                    {msg}
                  </div>
                )
              })}
            </div>
          </div>

          {/* 底部：所有玩家的地皮（按颜色分组） */}
          <div className="p-3 border-t border-white/10 max-h-44 overflow-y-auto">
            <div className="text-xs text-gray-500 mb-2">地皮归属</div>
            {game.players.filter(p => p.properties.length > 0).map(p => (
              <div key={p.id} className="mb-2">
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-xs">{p.avatar}</span>
                  <span className="text-xs font-medium" style={{ color: p.color }}>{p.name}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {p.properties.map(id => (
                    <span key={id} className="text-xs px-1.5 py-0.5 rounded text-white"
                      style={{ background: BOARD[id].color + '99' }}>
                      {BOARD[id].name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {game.players.every(p => p.properties.length === 0) && (
              <span className="text-xs text-gray-600">暂无地皮</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
