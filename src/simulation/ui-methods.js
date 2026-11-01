// Privileged native UI methods only; no data-plane or third-party channel command surface.
export const SIMULATION_UI_METHODS=Object.freeze([
  'overview','role.list','role.get','role.save','role.export','role.import','role.restore',
  'role.searchExamples','role.examples.search','role.context','role.preview',
  'legacy.inventory','legacy.import','room.list','room.create','room.get','room.update','room.search',
  'message.send','discussion.start','discussion.pause','discussion.cancel','discussion.resume','discussion.end',
  'project.create','project.start','project.refresh','memory.list','memory.propose','memory.confirm'
]);
