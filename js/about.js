/** About page: nav/footer only — content is a placeholder until the page is designed. */
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    BuddyNav.init('#site-nav', { active: 'about' });
    BuddyFooter.init('#site-footer', { showNewsletter: false });
    BuddyCart.initDrawer();
  });
})();
