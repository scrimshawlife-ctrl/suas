-- 0019_alameda_stanislaus_adjacency.sql — drop a county pair that does not share a border
--
-- 0013 stored bordering pairs among the seven launch counties and cited each county's
-- Wikipedia "Adjacent counties" list. A water border counts (San Mateo–Alameda, across
-- San Francisco Bay). Alameda and Stanislaus do not meet: Alameda's eastern neighbor is
-- San Joaquin, which is not a launch county. Santa Clara–Stanislaus stays.

DELETE FROM county_adjacency
 WHERE (county = 'ALAMEDA' AND adjacent_county = 'STANISLAUS')
    OR (county = 'STANISLAUS' AND adjacent_county = 'ALAMEDA');
