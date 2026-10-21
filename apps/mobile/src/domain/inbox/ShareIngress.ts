export type ShareInput =
  | {readonly type: 'url'; readonly value: string}
  | {readonly type: 'text'; readonly value: string}
  | {readonly type: 'image'; readonly name: string; readonly uri: string}
  | {readonly type: 'file'; readonly name: string; readonly uri: string};
