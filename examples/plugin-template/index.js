module.exports = {
  handlers: {
    async hello(input) {
      const name = typeof input?.name === 'string' ? input.name.slice(0, 80) : 'CetaMesh';
      return { greeting: `Hello, ${name}!` };
    }
  }
};
