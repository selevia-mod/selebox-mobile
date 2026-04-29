module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    isTestUpdate: process.env.IS_TEST_UPDATE === "true",
  },
});
