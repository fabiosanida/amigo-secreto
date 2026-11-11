// Simulação local do fluxo visual. O sorteio de produção será implementado no servidor.
export function createCycle(participants, random = Math.random) {
  if (participants.length < 3) throw new Error('São necessárias pelo menos 3 pessoas.');
  const order = [...participants];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((giver, index) => ({ giver, receiver: order[(index + 1) % order.length] }));
}
