import { pickLatestReportUrl } from './report-source';

const BASE =
  'https://environmentalhealth.gov.mt/en/ehs/wrau/bathing-water-programme/';

describe('pickLatestReportUrl', () => {
  it('picks the newest classification report by upload date', () => {
    const html = `
      <a href="/wp-content/uploads/2026/05/Site-Classification-Update-1.pdf">May report</a>
      <a href="/wp-content/uploads/2026/06/Site-Classification-Update-2.pdf">June report</a>
      <a href="/wp-content/uploads/2026/04/Site-Classification-Update-0.pdf">April report</a>
    `;
    expect(pickLatestReportUrl(html, BASE)).toBe(
      'https://environmentalhealth.gov.mt/wp-content/uploads/2026/06/Site-Classification-Update-2.pdf',
    );
  });

  it('picks the highest report week within the same upload month', () => {
    const html = `
      <a href="/wp-content/uploads/2026/06/Site-Classification-Week-5.pdf">Week 5</a>
      <a href="/wp-content/uploads/2026/06/Site-Classification-Week-3.pdf">Week 3</a>
      <a href="/wp-content/uploads/2026/06/Site-Classification-Week-4.pdf">Week 4</a>
    `;
    expect(pickLatestReportUrl(html, BASE)).toBe(
      'https://environmentalhealth.gov.mt/wp-content/uploads/2026/06/Site-Classification-Week-5.pdf',
    );
  });

  it('ignores PDFs that are not the classification report', () => {
    const html = `
      <a href="/wp-content/uploads/2026/06/BWP-1_Xghajra_2026.pdf">Bathing water profile</a>
      <a href="/wp-content/uploads/2026/06/Site-Classification-Update.pdf">classification report</a>
    `;
    expect(pickLatestReportUrl(html, BASE)).toBe(
      'https://environmentalhealth.gov.mt/wp-content/uploads/2026/06/Site-Classification-Update.pdf',
    );
  });

  it('matches on link text when the filename is opaque', () => {
    const html =
      '<a href="/wp-content/uploads/2026/06/report.pdf">Site Classification Update Report</a>';
    expect(pickLatestReportUrl(html, BASE)).toBe(
      'https://environmentalhealth.gov.mt/wp-content/uploads/2026/06/report.pdf',
    );
  });

  it('resolves absolute URLs and returns null when nothing matches', () => {
    expect(
      pickLatestReportUrl('<a href="/about">No PDFs here</a>', BASE),
    ).toBeNull();
    expect(
      pickLatestReportUrl(
        '<a href="https://example.org/classification.pdf">x</a>',
        BASE,
      ),
    ).toBe('https://example.org/classification.pdf');
  });
});
