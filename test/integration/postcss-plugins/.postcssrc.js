module.exports = {
  modules: true,
  plugins: {
    'postcss-modules': {
      generateScopedName: "_[name]__[local]"
    }
  }
};
