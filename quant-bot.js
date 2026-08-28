// Black Hole Quant Bot v1 — paper trading only
// Strategy: regime detection + momentum + breakout + mean reversion.
// Live order execution is intentionally disabled until the paper strategy is validated.

class BlackHoleQuantBot {
  constructor({startingCash = 10000, feeRate = 0.006, riskPerTrade = 0.01} = {}) {
    this.cash = startingCash;
    this.startingCash = startingCash;
    this.position = null;
    this.trades = [];
    this.feeRate = feeRate;
    this.riskPerTrade = riskPerTrade;
  }

  sma(values, n) {
    if (values.length < n) return null;
    const s = values.slice(-n);
    return s.reduce((a,b)=>a+b,0)/n;
  }

  std(values, n) {
    if (values.length < n) return null;
    const s = values.slice(-n);
    const m = s.reduce((a,b)=>a+b,0)/n;
    return Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/n);
  }

  rsi(values, n=14) {
    if (values.length <= n) return null;
    let g=0,l=0;
    for(let i=values.length-n;i<values.length;i++){
      const d=values[i]-values[i-1];
      if(d>=0) g+=d; else l-=d;
    }
    if(l===0) return 100;
    const rs=(g/n)/(l/n);
    return 100-(100/(1+rs));
  }

  regime(c) {
    const fast=this.sma(c,20), slow=this.sma(c,50), vol=this.std(c,20);
    if(!fast || !slow || !vol) return 'WARMUP';
    const price=c[c.length-1];
    const trend=Math.abs(fast-slow)/price;
    const volatility=vol/price;
    if(volatility > 0.02) return 'HIGH_VOL';
    if(trend > 0.008) return fast>slow ? 'TREND_UP' : 'TREND_DOWN';
    return 'RANGE';
  }

  signal(c) {
    if(c.length < 55) return {action:'HOLD', score:0, strategy:'warmup'};
    const price=c[c.length-1], fast=this.sma(c,20), slow=this.sma(c,50), rsi=this.rsi(c,14);
    const recentHigh=Math.max(...c.slice(-21,-1));
    const recentLow=Math.min(...c.slice(-21,-1));
    const reg=this.regime(c);
    let score=0, strategy='none';

    if(reg==='TREND_UP') {
      strategy='momentum';
      if(price>fast && fast>slow) score+=2;
      if(price>recentHigh) {score+=2; strategy='breakout';}
      if(rsi && rsi>55 && rsi<78) score+=1;
    } else if(reg==='RANGE') {
      strategy='mean_reversion';
      if(rsi && rsi<32 && price<fast) score+=3;
      if(rsi && rsi>68 && price>fast) score-=3;
      if(price<recentLow) score+=1;
    } else if(reg==='TREND_DOWN' || reg==='HIGH_VOL') {
      score-=2;
      strategy='risk_off';
    }

    return {action:score>=3?'BUY':score<=-3?'SELL':'HOLD',score,strategy,regime:reg,rsi,price};
  }

  sizeForTrade(price, stopPct=0.02) {
    const riskDollars=this.cash*this.riskPerTrade;
    return Math.max(0, Math.min(this.cash/price, riskDollars/(price*stopPct)));
  }

  step(candles) {
    const closes=candles.map(x=>Number(x.close));
    const sig=this.signal(closes);
    const price=closes[closes.length-1];
    if(sig.action==='BUY' && !this.position) {
      const qty=this.sizeForTrade(price);
      const cost=qty*price;
      const fee=cost*this.feeRate;
      if(cost+fee<=this.cash && qty>0){
        this.cash-=cost+fee;
        this.position={qty,entry:price,stop:price*0.98,take:price*1.04};
        this.trades.push({type:'BUY',price,qty,fee,time:Date.now(),strategy:sig.strategy});
      }
    }
    if(this.position){
      const shouldExit=sig.action==='SELL' || price<=this.position.stop || price>=this.position.take;
      if(shouldExit){
        const proceeds=this.position.qty*price;
        const fee=proceeds*this.feeRate;
        this.cash+=proceeds-fee;
        this.trades.push({type:'SELL',price,qty:this.position.qty,fee,time:Date.now(),strategy:sig.strategy});
        this.position=null;
      }
    }
    return {...sig,equity:this.equity(price),cash:this.cash,position:this.position};
  }

  equity(price){ return this.cash+(this.position?this.position.qty*price:0); }
}

window.BlackHoleQuantBot=BlackHoleQuantBot;
