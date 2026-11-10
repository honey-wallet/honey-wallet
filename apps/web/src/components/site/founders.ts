/** The founder the page sends people to: one place, so the handle is never out of step. */
export const FOUNDER = { name: 'Abhi', handle: 'Oxabhii', photo: '/founders/abhi.jpg' } as const;

/** Their chat, with the question already typed: nothing is sent until they send it. */
export const founderChat = `https://t.me/${FOUNDER.handle}?text=${encodeURIComponent(`Hi ${FOUNDER.name}, I have a question about Honey.`)}`;
